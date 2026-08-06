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

import { SESSION_ID } from "./live.ts";
import type { RefreshOutcome } from "./live.ts";

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

let bindings: PersistenceBindings | null = null;
const must = (): PersistenceBindings => {
  if (!bindings) throw new Error("persistence: wirePersistence() not called");
  return bindings;
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
const fingerprint = (g: unknown): string =>
  JSON.stringify(g, (_k, v) => {
    if (v === null) return undefined;
    if (Array.isArray(v) && v.length === 0) return undefined;
    return v;
  });

let savedFingerprint: string | null = null;

// Single writer for the saved-document baseline, so savedSnapshot and
// its fingerprint can't drift apart.
const setSaved = (body: string | null): void => {
  savedSnapshot = body;
  savedFingerprint = body === null ? null : fingerprint(JSON.parse(body));
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
    const r = await fetch("/state");
    noteRevision(r);
    g = (await r.json()) as GraphLike;
  }
  if (!g || !g.maps || g.maps.length === 0) {
    g = { maps: [{ path: "/", boxes: [], edges: [] }] };
  }
  b.setGraph(g);
  setSaved(JSON.stringify(g));
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

const saveBody = async (body: string): Promise<void> => {
  if (SNAPSHOT_MODE) {
    must().setStatus("local edits only — use Download or Save as new share");
    return;
  }
  savesInFlight++;
  try {
    const r = await fetch("/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Stamps this page's identity on the write so the live-events
        // stream can skip echoing the change back to us. Without it
        // every save would return as a full rebuild of our own work.
        [SESSION_HEADER]: SESSION_ID,
      },
      body,
    });
    noteRevision(r);
  } finally {
    savesInFlight--;
  }
  must().setStatus("saved");
};

const save = async (): Promise<void> => {
  const body = JSON.stringify(must().getGraph());
  if (savedSnapshot !== null && body !== savedSnapshot) {
    undoStack.push(savedSnapshot);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
  }
  setSaved(body);
  await saveBody(body);
};

const applyGraphSnapshot = (body: string): void => {
  const b = must();
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
  if (savedFingerprint === null) return true;
  if (saveTimer !== null || savesInFlight > 0) return true;
  if (b.isEditing?.()) return true;
  return fingerprint(b.getGraph()) !== savedFingerprint;
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
const applyRemoteGraph = (g: GraphLike, body: string): void => {
  const b = must();
  const previouslySelected = b.getSelectedIds?.() ?? [];
  b.setGraph(g);
  setSaved(body);
  // Undo policy: BOTH stacks are dropped.
  //
  // Every entry is a whole-document snapshot from before this change,
  // and undo doesn't just restore one — it POSTs it back through
  // saveBody. So the user's next Ctrl+Z would silently revert the
  // agent's edit and write that revert to disk, having never been
  // asked. There's no honest alternative without a merge model: a
  // snapshot the user made is no longer a document that ever existed.
  // Resetting costs history; keeping it costs the other party's work.
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
    const r = await fetch("/state");
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
  // Nothing to do — e.g. the agent's write raced our own save and the
  // file already says what we say. Not an error, and no rebuild: the
  // fingerprint compare is what stops a cosmetic shape difference
  // (see above) from costing a pointless full rebuild.
  if (fingerprint(g) === savedFingerprint) return "unchanged";
  applyRemoteGraph(g, JSON.stringify(g));
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
  const body = JSON.stringify(b.getGraph());
  if (savedSnapshot !== null && body !== savedSnapshot) {
    undoStack.push(savedSnapshot);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
    setSaved(body);
  }
  if (undoStack.length === 0) {
    b.setStatus("nothing to undo");
    return;
  }
  const prev = undoStack.pop()!;
  if (savedSnapshot !== null) redoStack.push(savedSnapshot);
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
