// Persistence + history. The two are joined here because they share
// the savedSnapshot / undoStack / redoStack state: each successful
// save() pushes the previous snapshot onto the undo stack, and undo()
// can flush a pending debounced save before stepping back.
//
// The module owns those four bindings (savedSnapshot, undoStack,
// redoStack, saveTimer) — main.ts no longer holds them. Public
// surface: load(), scheduleSave(), undo(), redo(), downloadFlowgo(),
// reshare(). Wire the host's live graph + setStatus + setGraph
// through wirePersistence().

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

// Snapshot mode: when the page is served at /m/<id>, edits live in
// browser memory only. /save is a no-op. The toolbar shows Download
// + Save-as-new-share; both go to the website's /api/snapshot
// endpoint (the page's origin).
const SNAPSHOT_MATCH = location.pathname.match(/^\/m\/([\w-]+)\/?$/);
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
    g = (await r.json()) as GraphLike;
  }
  if (!g || !g.maps || g.maps.length === 0) {
    g = { maps: [{ path: "/", boxes: [], edges: [] }] };
  }
  b.setGraph(g);
  savedSnapshot = JSON.stringify(g);
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
  saveTimer = setTimeout(save, DEBOUNCE_MS);
};

const saveBody = async (body: string): Promise<void> => {
  if (SNAPSHOT_MODE) {
    must().setStatus("local edits only — use Download or Save as new share");
    return;
  }
  await fetch("/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  must().setStatus("saved");
};

const save = async (): Promise<void> => {
  const body = JSON.stringify(must().getGraph());
  if (savedSnapshot !== null && body !== savedSnapshot) {
    undoStack.push(savedSnapshot);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
  }
  savedSnapshot = body;
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
    savedSnapshot = body;
  }
  if (undoStack.length === 0) {
    b.setStatus("nothing to undo");
    return;
  }
  const prev = undoStack.pop()!;
  if (savedSnapshot !== null) redoStack.push(savedSnapshot);
  savedSnapshot = prev;
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
  savedSnapshot = next;
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
