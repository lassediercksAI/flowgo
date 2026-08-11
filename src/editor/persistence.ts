// Persistence + history. The two are joined here because they share
// the savedSnapshot / undoStack / redoStack state: each successful
// save() pushes the previous snapshot onto the undo stack, and undo()
// can flush a pending debounced save before stepping back.
//
// The module owns those four bindings (savedSnapshot, undoStack,
// redoStack, saveTimer) — main.ts no longer holds them. Public
// surface: load(), scheduleSave(), undo(), redo(), downloadFlowgo(),
// reshare(), refreshFromServer(). Wire the host's live graph +
// setStatus + setGraph through wirePersistence().
//
// refreshFromServer() is the receiving end of the CLI's live-events
// stream (live.ts / pkg/flowgo/events.go): an agent edited the file
// under us, so re-read /state and put it on screen. The interesting
// part is when NOT to — see the dirty-document policy on
// refreshFromServer, and the undo-stack note on applyRemoteGraph.
//
// COST MODEL (brain#259). Everything in here that touches the whole
// document is O(map), so what matters is how many such passes an edit
// costs. On a 100,000-box map each pass is measured at: native
// stringify 9.1 ms, parse 19.4 ms, replacer-driven fingerprint 37.7 ms.
// The budget is:
//
//   an edit          1 stringify  — the /save body, which doubles as the
//                                   history entry (a reference copy)
//   an undo/redo     1 stringify + 1 parse
//   a remote event   1 fingerprint of the incoming document, + at most
//                    one parse+fingerprint to derive the baseline, and
//                    only once per baseline
//
// History is stored as whole-document snapshots on purpose — see the
// note on applyRemoteGraph for why inverse patches would be less safe
// here, not more. What snapshots cost is memory, not time, and that is
// bounded by HISTORY_BYTE_BUDGET rather than by entry count alone.

import { SESSION_ID } from "./live.ts";
import type { RefreshOutcome } from "./live.ts";
import { settleHexBoxIds } from "./hex.ts";

interface MapLike {
  path: string;
  boxes?: unknown[];
  edges?: unknown[];
  texts?: unknown[];
  lines?: unknown[];
  strokes?: unknown[];
}

interface GraphLike {
  maps: MapLike[];
}

interface PersistenceBindings {
  readonly getGraph: () => GraphLike;
  readonly setGraph: (g: GraphLike) => void;
  readonly serializeGraph: (g: GraphLike) => string;
  readonly setCurrentPath: (
    p: string,
    opts?: { keepViewport?: boolean },
  ) => void;
  readonly getCurrentPath: () => string;
  readonly readPathFromURL: () => string;
  readonly readViewFromURL: () => { s?: number; x?: number; y?: number } | null;
  readonly applyURLView: (v: { s?: number; x?: number; y?: number }) => void;
  readonly setStatus: (s: string) => void;
  readonly clearSelected: () => void;
  readonly clearSelectedEdge: () => void;
  // The three below exist for the live-events apply path and are
  // optional so a downstream consumer wiring this module by hand
  // keeps working. Without them a remote apply still lands; it just
  // can't see an open inline edit and won't restore selection.
  //
  // isEditing: a contenteditable label mid-edit holds text that isn't
  // in the graph yet, so the document is dirty even though a JSON
  // compare says otherwise.
  readonly isEditing?: () => boolean;
  readonly getSelectedIds?: () => string[];
  /** Re-select whichever of these ids still exist, and repaint. */
  readonly restoreSelection?: (ids: string[]) => void;
}

const UNDO_LIMIT = 100;
const DEBOUNCE_MS = 200;

// History entries are whole-document JSON strings, so their size is the
// size of the map. 100 of them on a 100,000-box document is ~1.1 GB of
// retained string — the editor would OOM long before the user ran out
// of Ctrl+Z. Cap the retained bytes across BOTH stacks as well as the
// entry count: small documents still get the full 100 steps (they never
// come near the budget), large ones trade depth for staying alive.
//
// Exported for the test that pins the bound.
export const HISTORY_BYTE_BUDGET = 64 * 1024 * 1024;

let bindings: PersistenceBindings | null = null;
const must = (): PersistenceBindings => {
  if (!bindings) throw new Error("persistence: wirePersistence() not called");
  return bindings;
};

// Whole-document pass counters (brain#259). Every one of these is O(map),
// so "how many run per edit" is the number that decides whether a large
// map is editable. Integer increments, so they cost nothing in
// production; the perf suite gates on them because they are identical on
// every machine, unlike wall-clock (see src/editor/perf/counters.ts for
// the same reasoning applied to DOM ops).
export interface GraphPasses {
  /** JSON.stringify of the whole document (the /save body). */
  stringify: number;
  /** JSON.parse of a whole document. */
  parse: number;
  /** Replacer-driven stringify for the dirty-check fingerprint. */
  fingerprint: number;
}

const passes: GraphPasses = { stringify: 0, parse: 0, fingerprint: 0 };

export const graphPasses = (): Readonly<GraphPasses> => ({ ...passes });
export const resetGraphPasses = (): void => {
  passes.stringify = 0;
  passes.parse = 0;
  passes.fingerprint = 0;
};

// Invariant repair on arrival: hexagons in a fetched graph can
// violate the never-overlap contract (raw imports, hand-edited files,
// pre-snap MCP writers) — the GUI's own gestures always settle, but a
// document written behind our back never did. Repair BEFORE anything
// fingerprints or serializes the graph, so the settled form is the
// only form this session ever compares against — a baseline of the
// raw form would read as permanently dirty and wedge the live-apply
// path ("deferred" forever). Deterministic, so every session settles
// an identical file identically.
const settleGraphHexes = (g: GraphLike): void => {
  for (const m of g.maps) {
    if (Array.isArray(m.boxes)) {
      settleHexBoxIds(
        m.boxes as Array<{ id: string; x: number; y: number; shape?: number }>,
      );
    }
  }
};

/** The one place the whole live document gets serialized. */
const serializeDoc = (g: GraphLike): string => {
  passes.stringify++;
  return JSON.stringify(g);
};

let savedSnapshot: string | null = null;
let undoStack: string[] = [];
let redoStack: string[] = [];

let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Saves already posted but not yet acknowledged. A remote apply while
// one is in flight would put the pre-save document on screen AND let
// the in-flight write land on top of the agent's edit — the browser
// and the file would then disagree with nobody left to notice.
let savesInFlight = 0;

/** Total retained history bytes, for the budget and for the tests. */
export const historyBytes = (): number => {
  let n = 0;
  for (const s of undoStack) n += s.length;
  for (const s of redoStack) n += s.length;
  return n;
};

export const historyDepth = (): { undo: number; redo: number } => ({
  undo: undoStack.length,
  redo: redoStack.length,
});

// Enforce both caps. Evicts from the FAR end of each stack — undoStack[0]
// is the oldest past, redoStack[0] is the most distant future — so the
// steps nearest the user's cursor in history are the last to go, and the
// redo branch (which the user has already stepped away from) goes before
// the past does. Always leaves at least one undo entry: dropping the step
// the user just made would make a large-map edit un-undoable, which is
// worse than any memory number.
const trimHistory = (): void => {
  while (undoStack.length > UNDO_LIMIT) undoStack.shift();
  while (redoStack.length > UNDO_LIMIT) redoStack.shift();
  let bytes = historyBytes();
  while (bytes > HISTORY_BYTE_BUDGET && redoStack.length > 0) {
    bytes -= redoStack.shift()!.length;
  }
  while (bytes > HISTORY_BYTE_BUDGET && undoStack.length > 1) {
    bytes -= undoStack.shift()!.length;
  }
};

// The document revision this page has seen, from the X-Flowgo-Revision
// header on /state and /save. live.ts compares incoming events against
// it so a duplicate or out-of-order event costs nothing.
let knownRevision = 0;
const REVISION_HEADER = "X-Flowgo-Revision";
const SESSION_HEADER = "X-Flowgo-Session";

export const getKnownRevision = (): number => knownRevision;

// A comparison key for "does this document hold anything the file
// doesn't", insensitive to the shape differences that carry no
// content:
//
//   - /state serializes a nil Go slice as `null` and omits absent
//     ones entirely, while navigation.ensureMap fills every container
//     on the current map with `[]` the moment we look at that map;
//   - so the live graph stops being JSON-identical to the body we
//     loaded the instant navigateTo runs — including during load()
//     itself.
//
// A raw string compare therefore reports "dirty" forever, which would
// mean the live-events apply path can never run and every incoming
// change sits behind a notice the user can't clear. Both forms mean
// the same document and serialize to the same .flowgo bytes, so the
// fingerprint drops empties on both sides. It does NOT drop non-empty
// content, so a genuinely emptied map still reads as a change.
const fingerprint = (g: unknown): string => {
  passes.fingerprint++;
  return JSON.stringify(g, (_k, v) => {
    if (v === null) return undefined;
    if (Array.isArray(v) && v.length === 0) return undefined;
    return v;
  });
};

// The fingerprint of savedSnapshot, derived LAZILY (brain#259).
//
// It used to be computed eagerly inside setSaved, which put a
// `JSON.parse` of the whole document plus a replacer-driven
// `JSON.stringify` of the whole document on the path of every single
// edit — a measured 19.4 ms + 37.7 ms on a 100,000-box map, i.e. 86 %
// of the per-edit cost, for a value that only the live-events gate ever
// reads. Deriving it on demand takes it off the mutation path entirely
// without changing what it compares: a save now costs one native
// stringify (the /save body, which is also the history entry), and the
// derivation happens at most once per incoming remote event.
//
// null means "not derived yet". Absence of a BASELINE is savedSnapshot
// === null — the two were conflated before and must not be again.
let savedFingerprint: string | null = null;

// Single writer for the saved-document baseline, so savedSnapshot and
// its fingerprint can't drift apart.
//
// `known` lets a caller that has ALREADY fingerprinted this exact
// document hand the value over instead of making us re-derive it from
// a parse (refreshFromServer computes one to decide whether anything
// changed at all).
const setSaved = (body: string | null, known?: string): void => {
  savedSnapshot = body;
  savedFingerprint = body === null ? null : (known ?? null);
};

const baselineFingerprint = (): string | null => {
  if (savedSnapshot === null) return null;
  if (savedFingerprint === null) {
    passes.parse++;
    savedFingerprint = fingerprint(JSON.parse(savedSnapshot));
  }
  return savedFingerprint;
};

const noteRevision = (r: Response): void => {
  const v = r.headers.get(REVISION_HEADER);
  if (v === null) return;
  const n = Number(v);
  if (Number.isFinite(n) && n > knownRevision) knownRevision = n;
};

// Snapshot mode: when the page is served at /m/<id>, edits live in
// browser memory only. /save is a no-op. The toolbar shows Download
// + Save-as-new-share; both go to the website's /api/snapshot
// endpoint (the page's origin).
//
// Guarded for `location` so this module stays importable under
// vitest's node environment — the apply path below is worth testing
// without standing up a DOM.
const SNAPSHOT_MATCH =
  typeof location === "undefined"
    ? null
    : location.pathname.match(/^\/m\/([\w-]+)\/?$/);
export const SNAPSHOT_ID: string | null = SNAPSHOT_MATCH
  ? SNAPSHOT_MATCH[1]!
  : null;
export const SNAPSHOT_MODE: boolean = SNAPSHOT_ID !== null;

// Which document this page is editing, as named by the host in the
// page's own query string (`?map=<name>`). Opaque here: the editor
// never parses it, it only hands it back on every data request.
//
// This is the same idea as SNAPSHOT_ID above — the page's URL says
// what it is looking at — applied to the editable document instead of
// a read-only snapshot. It exists because a host may serve many
// documents to one signed-in user, and "which one" has to survive a
// bookmark, a second tab and a reload; a server-side "current
// document" per session cannot do any of those (brain#272).
//
// THE CLI IS THE DEFAULT, NOT A SPECIAL CASE. `flowgo --host` serves
// one file at `/` with an empty query string, so MAP_ID is null, and
// dataURL() below returns "/state" and "/save" unchanged — the exact
// bytes on the wire the CLI has always seen. There is no flag to set
// and no second code path to keep in step: a host that does not name
// a document gets single-document behaviour by construction.
// An absent param and a present-but-empty one both mean "not named".
// Exported for the tests, which would otherwise have to reload this
// module once per URL shape to cover them.
export const mapIDFrom = (search: string): string | null =>
  new URLSearchParams(search).get("map") || null;

/** Build a data-endpoint URL for the given document name. */
export const dataURLFor = (mapID: string | null, path: string): string =>
  mapID === null ? path : path + "?map=" + encodeURIComponent(mapID);

// Resolved ONCE, at module load, on purpose: a page addresses one
// document for its whole life. Re-reading location on each request
// would let a history.pushState elsewhere in the host silently
// redirect an in-flight save to a different document.
export const MAP_ID: string | null =
  typeof location === "undefined" ? null : mapIDFrom(location.search);

/**
 * The data-endpoint URL for the document this page is editing.
 *
 * Every /state and /save request goes through here so the addressing
 * can never drift between reading and writing — a read that resolved
 * to a different document than the write would be a data-loss bug,
 * not a routing one.
 */
const dataURL = (path: string): string => dataURLFor(MAP_ID, path);

export const wirePersistence = (b: PersistenceBindings): void => {
  bindings = b;
};

export const load = async (): Promise<void> => {
  const b = must();
  let g: GraphLike | null = null;
  if (SNAPSHOT_MODE) {
    document.body.classList.add("snapshot-mode");
    document.getElementById("downloadBtn")?.style.setProperty("display", "");
    document.getElementById("reshareBtn")?.style.setProperty("display", "");
    try {
      const r = await fetch("/api/snapshot/" + encodeURIComponent(SNAPSHOT_ID!));
      if (!r.ok) throw new Error("HTTP " + r.status);
      const body = await r.json();
      g = (body.graph || body) as GraphLike;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      b.setStatus("snapshot " + SNAPSHOT_ID + " not loaded: " + msg);
      g = null;
    }
  } else {
    const r = await fetch(dataURL("/state"));
    noteRevision(r);
    g = (await r.json()) as GraphLike;
  }
  if (!g || !g.maps || g.maps.length === 0) {
    g = { maps: [{ path: "/", boxes: [], edges: [] }] };
  }
  settleGraphHexes(g);
  b.setGraph(g);
  setSaved(serializeDoc(g));
  undoStack = [];
  redoStack = [];
  // If the URL hash carries a view (?z=&x=&y=), apply it before
  // setCurrentPath so the initial navigateTo skips recenter and lands
  // exactly where the bookmark pinned us. With no view in the URL we
  // take the default recenter path.
  const urlView = b.readViewFromURL();
  if (urlView) {
    b.applyURLView(urlView);
    b.setCurrentPath(b.readPathFromURL(), { keepViewport: true });
  } else {
    b.setCurrentPath(b.readPathFromURL());
  }
  b.setStatus(SNAPSHOT_MODE ? "snapshot " + SNAPSHOT_ID + " — local edits only" : "loaded");
};

export const scheduleSave = (): void => {
  must().setStatus("saving…");
  if (saveTimer) clearTimeout(saveTimer);
  // Clearing the handle when the debounce fires is what makes
  // `saveTimer !== null` mean "a save is pending" rather than "a save
  // was scheduled at some point in this session" — which is what
  // isDirty() needs it to mean. undo()'s flush-then-step-back check
  // reads the same binding and was previously clearing an already-
  // fired timer.
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save();
  }, DEBOUNCE_MS);
};

// Blob is global in every browser the editor supports and in Node >= 18,
// but the fallback keeps this module importable anywhere and keeps the
// request correct if it ever isn't there.
const toBody = (body: string): Blob | string =>
  typeof Blob === "undefined" ? body : new Blob([body], { type: "application/json" });

const saveBody = async (body: string): Promise<void> => {
  if (SNAPSHOT_MODE) {
    must().setStatus("local edits only — use Download or Save as new share");
    return;
  }
  savesInFlight++;
  try {
    const r = await fetch(dataURL("/save"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Stamps this page's identity on the write so the live-events
        // stream can skip echoing the change back to us. Without it
        // every save would return as a full rebuild of our own work.
        [SESSION_HEADER]: SESSION_ID,
      },
      // Sent as a Blob, not as the string (brain#259). Handing fetch a
      // multi-megabyte string makes it copy the whole thing into the
      // request on the main thread: on a 100,000-box map that is a
      // measured 83-133 ms blocked frame, and after the bookkeeping
      // above was fixed it was the ENTIRE remaining hitch of an edit —
      // more than ten times the 9.5 ms the serialization itself costs.
      // Wrapping it hands the bytes to the blob store instead and the
      // upload reads from there, which takes the copy off the frame:
      // same request, same Content-Type, same bytes on the wire, worst
      // frame 18.6 ms — i.e. none.
      body: toBody(body),
    });
    noteRevision(r);
  } finally {
    savesInFlight--;
  }
  must().setStatus("saved");
};

// The whole per-edit cost, and the reason a large map is editable at
// all (brain#259): ONE native stringify of the document. It is the
// /save body; pushing the previous body onto the undo stack is a
// reference copy on a string that already existed, and the !== is a
// memcmp. Nothing here parses, and nothing here fingerprints.
const save = async (): Promise<void> => {
  const body = serializeDoc(must().getGraph());
  if (savedSnapshot !== null && body !== savedSnapshot) {
    undoStack.push(savedSnapshot);
    redoStack = [];
    trimHistory();
  }
  setSaved(body);
  await saveBody(body);
};

const applyGraphSnapshot = (body: string): void => {
  const b = must();
  passes.parse++;
  const g = JSON.parse(body) as GraphLike;
  b.setGraph(g);
  b.clearSelected();
  b.clearSelectedEdge();
  const cur = b.getCurrentPath();
  const target = g.maps.some((m) => m.path === cur) ? cur : "/";
  // Undo/redo of an in-place edit shouldn't recentre — the user's pan
  // is part of the view state, not the graph state. Only fall back
  // to recentre when we actually had to switch maps (e.g. the current
  // submap got removed by the snapshot we're stepping into).
  b.setCurrentPath(target, { keepViewport: target === cur });
};

// ---------------------------------------------------------------
// Live events: pulling a change made by someone else.
// ---------------------------------------------------------------

/**
 * Does this page hold anything the server doesn't? Used as the gate on
 * a remote apply — if this is true, applying would destroy work.
 *
 * "Dirty" is broader than a JSON diff on purpose:
 *  - a pending debounced save, or one already in flight, means the
 *    graph and the file are mid-handshake;
 *  - an open inline label edit holds characters that haven't reached
 *    the graph at all, so a diff would call it clean and the apply
 *    would rip the contenteditable out from under the cursor;
 *  - before the first load there's no baseline, so nothing is safe to
 *    conclude.
 */
export const isDirty = (): boolean => {
  const b = must();
  if (savedSnapshot === null) return true;
  if (saveTimer !== null || savesInFlight > 0) return true;
  if (b.isEditing?.()) return true;
  // The content compare stays. A cheap "has anything called scheduleSave
  // since the last save" flag would be wrong: a box drag mutates b.x/b.y
  // live on every mousemove and only fires a mutation on release, so
  // mid-drag the flag reads clean while the document has moved. That is
  // precisely the window a remote apply must not walk into. It is safe
  // to leave this O(map) because it is reached only when the three cheap
  // gates above all say clean — i.e. once per incoming remote event on
  // an idle page, never on the editing path (brain#259).
  return fingerprint(b.getGraph()) !== baselineFingerprint();
};

// applyRemoteGraph swaps in a document produced elsewhere (an agent
// over MCP, another tab, an external editor).
//
// This is a WHOLESALE replacement, so it takes the full rebuild path —
// setCurrentPath → navigateTo → renderAll — and deliberately not the
// renderItems fast path (#238): we have no idea which items changed,
// and renderItems on a stale id set would leave the DOM lying. The
// trailing applyViewport inside navigateTo re-fires the cull hook
// (#23a), so the visible set is re-evaluated against the current
// camera rather than left showing whatever was materialised before.
//
// What is preserved: the camera (pan + zoom) and the current submap.
// Recentering or navigating someone away mid-session is the difference
// between "the agent is drawing on my map" and "my map keeps jumping".
// The only time we recenter is when the submap we were in no longer
// exists in the incoming document — same rule undo/redo already uses.
const applyRemoteGraph = (g: GraphLike, body: string, fp?: string): void => {
  const b = must();
  const previouslySelected = b.getSelectedIds?.() ?? [];
  b.setGraph(g);
  // The caller already fingerprinted this exact document to decide the
  // change was real; handing it over saves re-deriving it from a parse.
  setSaved(body, fp);
  // Undo policy: BOTH stacks are dropped.
  //
  // Every entry is a whole-document snapshot from before this change,
  // and undo doesn't just restore one — it POSTs it back through
  // saveBody. So the user's next Ctrl+Z would silently revert the
  // agent's edit and write that revert to disk, having never been
  // asked. There's no honest alternative without a merge model: a
  // snapshot the user made is no longer a document that ever existed.
  // Resetting costs history; keeping it costs the other party's work.
  //
  // brain#259 kept this line deliberately, and kept the representation
  // that makes it necessary. An inverse-patch history would not have
  // been safer here — it would have been less safe: a patch's inverse
  // names ids and positions in a document that no longer exists, so
  // replaying one over the other writer's version is a merge with no
  // conflict detection. Whole snapshots at least make the hazard
  // obvious enough to have been guarded.
  undoStack = [];
  redoStack = [];
  b.clearSelected();
  b.clearSelectedEdge();
  const cur = b.getCurrentPath();
  const target = g.maps.some((m) => m.path === cur) ? cur : "/";
  b.setCurrentPath(target, { keepViewport: target === cur });
  // Selection survives if we stayed put; the host filters out ids the
  // incoming document no longer has.
  if (target === cur) b.restoreSelection?.(previouslySelected);
};

/**
 * Re-read /state and put it on screen if that's safe. Called by
 * live.ts when the event stream reports a revision we don't have.
 *
 * The dirty-document policy is the load-bearing decision here: if the
 * local document has unsaved work we do NOT apply and do NOT merge —
 * we report "deferred" and let the caller retry. Silently merging is
 * the yrs/CRDT path and is out of scope; silently clobbering is worse
 * than showing nothing. Once the pending save lands, the retry finds a
 * clean document, and by then /state includes the user's own work, so
 * applying can't lose it.
 */
export const refreshFromServer = async (): Promise<RefreshOutcome> => {
  const b = must();
  // Snapshot mode has no server-side document to track.
  if (SNAPSHOT_MODE) return "unchanged";
  if (isDirty()) return "deferred";
  let g: GraphLike;
  try {
    const r = await fetch(dataURL("/state"));
    if (!r.ok) throw new Error("HTTP " + r.status);
    noteRevision(r);
    g = (await r.json()) as GraphLike;
  } catch {
    return "failed";
  }
  if (!g || !Array.isArray(g.maps) || g.maps.length === 0) return "failed";
  // Re-check AFTER the await. The fetch is a suspension point measured
  // in milliseconds, but a keystroke or a drag fits in it easily, and
  // applying over that would silently drop it.
  if (isDirty()) return "deferred";
  settleGraphHexes(g);
  // Nothing to do — e.g. the agent's write raced our own save and the
  // file already says what we say. Not an error, and no rebuild: the
  // fingerprint compare is what stops a cosmetic shape difference
  // (see above) from costing a pointless full rebuild.
  const fp = fingerprint(g);
  if (fp === baselineFingerprint()) return "unchanged";
  applyRemoteGraph(g, serializeDoc(g), fp);
  return "applied";
};

export const undo = (): void => {
  const b = must();
  // Flush any pending save so the snapshot reflects the latest change
  // before we step back.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const body = serializeDoc(b.getGraph());
  if (savedSnapshot !== null && body !== savedSnapshot) {
    undoStack.push(savedSnapshot);
    redoStack = [];
    trimHistory();
    setSaved(body);
  }
  if (undoStack.length === 0) {
    b.setStatus("nothing to undo");
    return;
  }
  const prev = undoStack.pop()!;
  if (savedSnapshot !== null) redoStack.push(savedSnapshot);
  trimHistory();
  setSaved(prev);
  applyGraphSnapshot(prev);
  void saveBody(prev);
  b.setStatus("undo (" + undoStack.length + " left)");
};

export const redo = (): void => {
  const b = must();
  if (redoStack.length === 0) {
    b.setStatus("nothing to redo");
    return;
  }
  const next = redoStack.pop()!;
  if (savedSnapshot !== null) undoStack.push(savedSnapshot);
  trimHistory();
  setSaved(next);
  applyGraphSnapshot(next);
  void saveBody(next);
  b.setStatus("redo");
};

export const downloadFlowgo = (): void => {
  const b = must();
  const text = b.serializeGraph(b.getGraph());
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (SNAPSHOT_ID ?? "mindmap") + ".flowgo";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  b.setStatus("downloaded");
};

export const reshare = async (): Promise<void> => {
  const b = must();
  b.setStatus("re-sharing…");
  try {
    const r = await fetch("/api/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph: b.getGraph() }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const body = await r.json();
    if (!body.url) throw new Error("response missing url");
    if (navigator.clipboard) {
      navigator.clipboard.writeText(body.url).catch(() => { /* noop */ });
    }
    b.setStatus("new share: " + body.url + " (copied)");
    if (body.id) history.pushState(null, "", "/m/" + body.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    b.setStatus("re-share failed: " + msg);
  }
};
