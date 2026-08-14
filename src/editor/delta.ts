// Client half of the delta1 incremental-save protocol (brain#25c).
//
// The server half (pkg/flowgo/delta.go) accepts `X-Flowgo-Save:
// delta1` bodies carrying only what changed; this module decides WHAT
// changed. Two parts:
//
//   1. A dirty set fed by the mutation seam (mutations.ts). Every
//      mutator names a kind and the map it fired on, so the set is
//      keyed (map path → dirty kinds) plus a document-level flag for
//      mutations that can span maps (delete-with-submaps, default
//      shape) and an overflow flag for anything this module does not
//      recognise — overflow means "tracking is incomplete, send the
//      full document", never "guess".
//
//   2. buildDelta, a pure diff: given the exact body the server last
//      acknowledged and the live graph, it derives ops for the dirty
//      scopes ONLY. Deriving ops by diffing (rather than recording
//      ids at the mutation seam) is what makes deletes fall out
//      correctly for free: an id present in the base but gone from
//      the live graph is a delete, an id upserted-then-deleted inside
//      one debounce window never differs from the base at all, and a
//      mutation that arrives while a save is in flight simply still
//      differs from the base at the NEXT save. The dirty set is a
//      scope (which collections to compare), not a ledger — it must
//      be a superset of the real changes, and stale entries cost a
//      no-op compare, not a wrong op.
//
// The wire shapes here mirror pkg/flowgo/delta.go verbatim; that file
// is the source of truth.

export type DirtyKind = "box" | "text" | "line" | "stroke" | "image" | "edge";

const ID_KINDS = ["box", "text", "line", "stroke", "image"] as const;
const ALL_KINDS: readonly DirtyKind[] = [...ID_KINDS, "edge"];

// The graph field each id-carrying kind lives in.
const FIELD: Record<(typeof ID_KINDS)[number], string> = {
  box: "boxes",
  text: "texts",
  line: "lines",
  stroke: "strokes",
  image: "images",
};

export interface DirtySet {
  /** map path → kinds whose collection may differ from the base. */
  readonly maps: Map<string, Set<DirtyKind>>;
  /** A mutation that can touch any map / doc-level fields fired. */
  doc: boolean;
  /** A mutation this module doesn't understand fired → full save. */
  overflow: boolean;
}

const emptyDirty = (): DirtySet => ({
  maps: new Map(),
  doc: false,
  overflow: false,
});

let dirty: DirtySet = emptyDirty();

const kindsFor = (mapPath: string): Set<DirtyKind> => {
  let s = dirty.maps.get(mapPath);
  if (!s) {
    s = new Set();
    dirty.maps.set(mapPath, s);
  }
  return s;
};

/**
 * Record one mutation-seam event. Called by mutations.ts on EVERY
 * mutation, whether or not delta saves are active — the bookkeeping is
 * O(1) and keeping it unconditional means the set is already correct
 * the moment a capable server arms the delta path.
 */
export const markMutation = (kind: string, mapPath: string): void => {
  switch (kind) {
    case "box":
    case "text":
    case "line":
    case "stroke":
    case "image":
    case "edge":
      kindsFor(mapPath).add(kind);
      break;
    case "currentMap":
      // Spans kinds on one map (paste, align, palette sweep).
      for (const k of ALL_KINDS) kindsFor(mapPath).add(k);
      break;
    case "doc":
      // Spans maps (submap cascade on delete) and doc-level fields
      // (defaultShape) — the diff must look at everything.
      dirty.doc = true;
      break;
    default:
      // A mutation kind this module doesn't know cannot be scoped, so
      // tracking is no longer complete. Fail toward the full save.
      dirty.overflow = true;
  }
};

/** Read the current set without consuming it. */
export const peekDirty = (): DirtySet => dirty;

/**
 * Take ownership of the current set, leaving a fresh empty one so
 * mutations that land while a save is in flight accumulate separately
 * and survive to the next save.
 */
export const takeDirty = (): DirtySet => {
  const t = dirty;
  dirty = emptyDirty();
  return t;
};

/** Union a previously taken set back in (the save it scoped died). */
export const restoreDirty = (s: DirtySet): void => {
  for (const [path, kinds] of s.maps) {
    const cur = kindsFor(path);
    for (const k of kinds) cur.add(k);
  }
  if (s.doc) dirty.doc = true;
  if (s.overflow) dirty.overflow = true;
};

export const clearDirty = (): void => {
  dirty = emptyDirty();
};

// ---------------------------------------------------------------
// buildDelta — the pure diff.
// ---------------------------------------------------------------

// Structural views of the graph; elements stay opaque except for the
// id, exactly like the server's json.RawMessage handling.
interface DeltaMap {
  path: string;
  edges?: unknown[];
  [collection: string]: unknown;
}
export interface DeltaGraph {
  maps: DeltaMap[];
  defaultShape?: number;
}

interface DeltaOp {
  op: "upsert" | "delete" | "set-kind" | "set-edges" | "set-map" | "drop-map";
  kind?: string;
  map?: string;
  id?: string;
  item?: unknown;
  items?: unknown;
  edges?: unknown;
}

const idOf = (item: unknown): string | null => {
  if (typeof item !== "object" || item === null) return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
};

// Diff one id-keyed collection into upsert/delete ops. Position is
// part of byte parity (upsertByID replaces in place, appends new), so
// after computing ops we verify the order they would produce server-
// side matches the live order; a mismatch (reorder) has no cheap op
// and collapses into one set-kind replacing the whole collection.
// Returns null only when an element has no usable id — that is lost
// tracking, and the caller falls back to the full save.
const diffKind = (
  kind: string,
  map: string,
  baseItems: unknown[],
  curItems: unknown[],
): DeltaOp[] | null => {
  const baseBy = new Map<string, unknown>();
  const baseIds: string[] = [];
  for (const it of baseItems) {
    const id = idOf(it);
    if (id === null) return null;
    baseBy.set(id, it);
    baseIds.push(id);
  }
  const ops: DeltaOp[] = [];
  const curIds = new Set<string>();
  const order: string[] = []; // live order, for the parity check
  const appended: string[] = [];
  let duplicate = false;
  for (const it of curItems) {
    const id = idOf(it);
    if (id === null) return null;
    if (curIds.has(id)) duplicate = true;
    curIds.add(id);
    order.push(id);
    const b = baseBy.get(id);
    if (b === undefined) {
      appended.push(id);
      ops.push({ op: "upsert", kind, map, item: it });
    } else if (JSON.stringify(it) !== JSON.stringify(b)) {
      ops.push({ op: "upsert", kind, map, item: it });
    }
  }
  for (const id of baseIds) {
    if (!curIds.has(id)) ops.push({ op: "delete", kind, map, id });
  }
  if (ops.length === 0) return ops;
  // Predicted server-side order: base order minus deletes, new ids
  // appended in op order.
  const predicted = baseIds.filter((id) => curIds.has(id)).concat(appended);
  const parity =
    !duplicate &&
    predicted.length === order.length &&
    predicted.every((id, i) => id === order[i]);
  if (!parity) {
    return [{ op: "set-kind", kind, map, items: curItems }];
  }
  return ops;
};

/**
 * Diff the live graph against the exact body the server acknowledged,
 * scoped by the dirty set, into a delta1 request body. Returns the
 * JSON string, or null when the change has no delta expression (lost
 * tracking, id-less elements, a removed map with surviving
 * descendants) — null always means "send the full document".
 */
export const buildDelta = (
  base: DeltaGraph,
  cur: DeltaGraph,
  scope: DirtySet,
  baseRevision: number,
): string | null => {
  if (scope.overflow) return null;
  const baseBy = new Map(base.maps.map((m) => [m.path, m]));
  const curBy = new Map(cur.maps.map((m) => [m.path, m]));
  const ops: DeltaOp[] = [];
  let doc: { defaultShape: number } | undefined;
  if (scope.doc) {
    // Map-set diff. drop-map takes the whole "/"-boundary subtree
    // (see dropMapAndSubtree in pkg/flowgo/delta.go), so: dedup
    // removed paths that already fall under a dropped ancestor, and
    // refuse the delta when a removed path still has a LIVE
    // descendant — dropping it would destroy a map the client kept.
    const removed = [...baseBy.keys()].filter((p) => !curBy.has(p)).sort();
    const drops: string[] = [];
    for (const p of removed) {
      if (drops.some((d) => p === d || p.startsWith(d + "/"))) continue;
      for (const q of curBy.keys()) {
        if (q.startsWith(p + "/")) return null;
      }
      drops.push(p);
    }
    for (const p of drops) ops.push({ op: "drop-map", map: p });
    for (const p of curBy.keys()) {
      if (!baseBy.has(p)) ops.push({ op: "set-map", map: p });
    }
    const shape = cur.defaultShape ?? 0;
    if (shape !== (base.defaultShape ?? 0)) doc = { defaultShape: shape };
  }
  // Content scope: doc-dirty widens to every live map and kind (a doc
  // mutation may have touched any of them); otherwise exactly the
  // dirty (map, kind) pairs.
  const scoped: Iterable<[string, Iterable<DirtyKind>]> = scope.doc
    ? [...curBy.keys()].map((p): [string, Iterable<DirtyKind>] => [p, ALL_KINDS])
    : scope.maps;
  for (const [path, kinds] of scoped) {
    const cm = curBy.get(path);
    if (!cm) {
      // Element dirt on a map that no longer exists: expressible only
      // when the doc diff above already dropped it.
      if (scope.doc) continue;
      return null;
    }
    const bm = baseBy.get(path);
    for (const kind of kinds) {
      if (kind === "edge") {
        // Edges carry no ids (see delta.go) — any difference replaces
        // the map's whole edge array.
        const be = (bm?.edges ?? []) as unknown[];
        const ce = (cm.edges ?? []) as unknown[];
        if (JSON.stringify(be) !== JSON.stringify(ce)) {
          ops.push({ op: "set-edges", map: path, edges: ce });
        }
        continue;
      }
      const field = FIELD[kind];
      const kindOps = diffKind(
        kind,
        path,
        (bm?.[field] ?? []) as unknown[],
        (cm[field] ?? []) as unknown[],
      );
      if (kindOps === null) return null;
      ops.push(...kindOps);
    }
  }
  const delta: { base: number; ops: DeltaOp[]; doc?: { defaultShape: number } } =
    { base: baseRevision, ops };
  if (doc) delta.doc = doc;
  return JSON.stringify(delta);
};
