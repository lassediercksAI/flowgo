// @ts-nocheck — strict-typing this file is queued; it's now small
// enough that doing it in one pass is reasonable, but the surrounding
// tests catch enough regressions that the TS overhead isn't yet
// pulling its weight.
//
// What's here: the editor's bootstrap. Module-level mutable state
// (graph, currentMap, selection, drag/link/pan/band/edit cursors),
// DOM bindings, the wireX({...}) registration calls that hand the
// extracted feature modules their slices of state, and the once-at-
// startup setup (toolbar buttons, resize listener, initial load).
//
// Everything else lives in src/editor/* — the imports below are the
// directory map of the app.

import {
  hasSubmapContent,
  serializeGraph as serializeGraphPure,
} from "../index.ts";

import { attachHelpListeners } from "./help.ts";
import {
  recenter as recenterPure,
  toDataX,
  toDataY,
  wireViewportCullHook,
  withSuppressedViewSync,
} from "./viewport.ts";
import { wireCulling } from "./culling.ts";
import { editingId } from "./edit.ts";
import { isBrushMode, wireBrush } from "./brush.ts";
import { wireDefaultShape } from "./default-shape.ts";
import { wireLine } from "./line.ts";
import { wireTextMode } from "./text-mode.ts";
import { wireClipboard } from "./clipboard.ts";
import {
  applyURLView,
  attachNavigationListeners,
  ensureMap,
  goUp,
  navigateTo,
  readPathFromURL,
  readViewFromURL,
  wireNavigation,
} from "./navigation.ts";
import {
  downloadFlowgo,
  getKnownRevision,
  load,
  refreshFromServer,
  reshare,
  scheduleSave,
  SNAPSHOT_MODE,
  wirePersistence,
} from "./persistence.ts";
import { startLive, wireLive } from "./live.ts";
import { mutatedCurrentMap, wireMutations } from "./mutations.ts";
import { exposeCollabHandle } from "./collab-api.ts";
import {
  cloneSelection as cloneSelectionPure,
  wireClone,
} from "./clone.ts";
import { wireEdit } from "./edit.ts";
import { invalidateUidCache, mintId, wireUid } from "./uid.ts";
import {
  applyClasses,
  clearProximity,
  getBoxEl,
  getTextEl,
  renderAll,
  renderItems,
  scheduleCullUpdate,
  wireProximity,
  wireRender,
} from "./render.ts";
import { deleteSelection, wireFactories } from "./factories.ts";
import { applyShapeToSelection, attachKeyboardListener, wireKeys } from "./keys.ts";
import { attachMouseListeners, wireMouse } from "./mouse.ts";
import { attachTouchListeners, wireTouch } from "./touch.ts";
import {
  attachBoxHandlers,
  attachImageHandlers,
  attachLineHandlers,
  attachStrokeHandlers,
  attachTextHandlers,
  wireAttach,
} from "./attach.ts";
import { attachMediaListeners, wireMedia } from "./media.ts";
import { attachAlignToolbar, wireAlign } from "./align.ts";
import { attachContextBar, wireContextBar } from "./contextbar.ts";
import { attachZoomControl } from "./zoomctl.ts";

// ---------------------------------------------------------------
// Module-level state. Every feature module reaches these through its
// wireX() bindings; nothing else in this file mutates them.
// ---------------------------------------------------------------

let graph = { maps: [] };
let currentPath = "/";
let state = { boxes: [], edges: [] };  // alias for the current map
const selected = new Set();
const lastCursor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

let band = null;          // rubber-band selection
let pan = null;           // right-click drag
let drag = null;          // box / text / line drag
let link = null;          // link drag from a handle dot
let selectedEdge = null;  // entry in state.edges
let dropTargetId = null;  // box under cursor during link drag
let dropTargetHandle = null; // handle code on dropTargetId that would receive the edge
let nearTargetId = null;  // box close enough to the cursor for proximity

// ---------------------------------------------------------------
// DOM bindings
// ---------------------------------------------------------------

const canvas = document.getElementById("canvas");
const edgeLayer = document.getElementById("edge-layer");
const lineLayer = document.getElementById("line-layer");
const strokeLayer = document.getElementById("stroke-layer");
const ghostLine = document.getElementById("ghost-line");

// ---------------------------------------------------------------
// Live helpers that close over module state. Each is small enough to
// not warrant its own file.
// ---------------------------------------------------------------

// Memoized per user action — see uid.ts for why (a bulk paste used to
// spend more time minting ids than rendering).
const uid = (prefix) => mintId(prefix);

const findTextById = (id) => state.texts.find((t) => t.id === id);
const findLineById = (id) => state.lines.find((l) => l.id === id);
const findStrokeById = (id) => (state.strokes || []).find((s) => s.id === id);
const findImageById = (id) => (state.images || []).find((i) => i.id === id);

// Does this id still name something on the current map? Used when a
// live apply (live.ts) replaces the document wholesale and we want the
// user's selection back — minus whatever the incoming document deleted.
const existsOnCurrentMap = (id) =>
  (state.boxes || []).some((b) => b.id === id) ||
  (state.texts || []).some((t) => t.id === id) ||
  (state.lines || []).some((l) => l.id === id) ||
  (state.strokes || []).some((s) => s.id === id) ||
  (state.images || []).some((i) => i.id === id);

const recenter = () => recenterPure(state);

function setStatus(_s) {
  // Status hint area was removed; keep callers harmless.
}

// cloneSelection wraps the pure clone with the render + save trail
// the existing call sites expect.
//
// Alt-drag clone adds a known set of brand-new ids, so it takes the
// incremental path (#24f): the originals keep their elements and
// renderItems' trailing applyClasses moves the `selected` classes off
// them onto the clones. The empty-idMap case (a selection of only
// non-clonable items) still needs that class move, hence the fallback.
function cloneSelection() {
  const idMap = cloneSelectionPure();
  if (idMap.size > 0) renderItems(idMap.values());
  else applyClasses();
  mutatedCurrentMap();
  return idMap;
}

// ---------------------------------------------------------------
// Wire each feature module to the live state it operates on.
// ---------------------------------------------------------------

wireRender({
  canvas,
  lineLayer,
  strokeLayer,
  edgeLayer,
  currentMap: () => state,
  graph: () => graph,
  currentPath: () => currentPath,
  selected,
  selectedEdge: () => selectedEdge,
  setSelectedEdge: (e) => { selectedEdge = e; },
  dropTargetId: () => dropTargetId,
  dropTargetHandle: () => dropTargetHandle,
  nearTargetId: () => nearTargetId,
  attachBoxHandlers,
  attachTextHandlers,
  attachImageHandlers,
  attachStrokeHandlers,
  attachLineHandlers,
  isBrushMode: () => isBrushMode(),
  setStatus,
});

wireProximity({
  currentMap: () => state,
  link: () => link,
  nearTargetId: () => nearTargetId,
  setNearTargetId: (id) => { nearTargetId = id; },
});

wireUid({ currentMap: () => state });

// Viewport culling (#23a): only items within the on-screen data-space
// rect (+ margin, see render.ts/culling.ts) get DOM. The provider maps
// the window corners into data space — zoom and pan are both captured
// by toDataX/toDataY. Pan/zoom funnels through applyViewport, whose
// cull hook re-evaluates the visible set (rAF-throttled) without a
// full re-render.
wireCulling({
  viewport: () => ({
    x1: toDataX(0),
    y1: toDataY(0),
    x2: toDataX(window.innerWidth),
    y2: toDataY(window.innerHeight),
  }),
  // Never cull the box/text with a live inline label edit.
  exemptIds: () => {
    const id = editingId();
    return id ? [id] : [];
  },
});
wireViewportCullHook(scheduleCullUpdate);

wireNavigation({
  getGraph: () => graph,
  getCurrentPath: () => currentPath,
  setCurrentPath: (p) => { currentPath = p; },
  setCurrentMap: (m) => { state = m; },
  clearSelected: () => selected.clear(),
  clearSelectedEdge: () => { selectedEdge = null; },
  renderAll: () => renderAll(),
});
attachNavigationListeners();

wireAttach({
  canvas,
  lineLayer,
  strokeLayer,
  ghostLine,
  currentMap: () => state,
  findTextById,
  findLineById,
  findStrokeById,
  selected,
  selectedEdge: () => selectedEdge,
  setSelectedEdge: (e) => { selectedEdge = e; },
  setDrag: (d) => { drag = d; },
  setLink: (l) => { link = l; },
  cloneSelection,
  setStatus,
});

wireFactories({
  canvas,
  currentMap: () => state,
  setCurrentMap: (m) => { state = m; },
  graph: () => graph,
  setGraph: (g) => { graph = g; },
  currentPath: () => currentPath,
  ensureMap,
  selected,
  selectedEdge: () => selectedEdge,
  clearSelectedEdge: () => { selectedEdge = null; },
  mintId: uid,
  setStatus,
});

wireEdit({
  canvas,
  getCurrentMap: () => state,
  setCurrentMap: (m) => { state = m; },
  getCurrentPath: () => currentPath,
  getGraph: () => graph,
  setGraph: (g) => { graph = g; },
  ensureMap,
  selected,
  renderAll: () => renderAll(),
  renderItem: (id) => renderItems([id]),
  setStatus,
});

wirePersistence({
  getGraph: () => graph,
  setGraph: (g) => {
    graph = g;
    // The document's default shape (graph.defaultShape) needs no
    // boot-time projection: default-shape.ts reads it live through
    // its getGraph binding, so load / import / undo / redo are
    // covered by this assignment alone.
    //
    // The id cache DOES need dropping: this assignment brings in a
    // whole document whose ids the memoized minter has never seen, so
    // the next local mint could collide (#24f). Same reason the
    // collab applyRemotePatch below invalidates.
    invalidateUidCache();
  },
  serializeGraph: serializeGraphPure,
  setCurrentPath: (p, opts) => navigateTo(p, opts),
  getCurrentPath: () => currentPath,
  readPathFromURL,
  readViewFromURL,
  applyURLView,
  setStatus,
  clearSelected: () => selected.clear(),
  clearSelectedEdge: () => { selectedEdge = null; },
  // A live apply must not rip a contenteditable out from under the
  // cursor: an open inline label edit counts as unsaved work even
  // though its characters aren't in the graph yet.
  isEditing: () => editingId() !== null,
  getSelectedIds: () => [...selected],
  // Called AFTER the apply's full rebuild, so the elements exist and
  // carry no interaction classes yet. Adding to `selected` and then
  // calling applyClasses is the diff-based path (#237): it toggles
  // exactly the ids we re-added and attaches their chrome (#239).
  restoreSelection: (ids) => {
    let restored = false;
    for (const id of ids) {
      if (existsOnCurrentMap(id)) {
        selected.add(id);
        restored = true;
      }
    }
    if (restored) applyClasses();
  },
});

// Live document events (brain#250): the CLI's /events stream tells
// this page when the .flowgo changed underneath it — an agent editing
// over MCP, a second tab, or the file being edited in vim. live.ts
// owns the transport and retry policy; refreshFromServer owns what is
// safe to apply.
wireLive({
  refresh: () => refreshFromServer(),
  knownRevision: () => getKnownRevision(),
  setStatus,
});

// Every mutation funnels through mutations.ts. The default wiring
// just calls scheduleSave; downstream consumers can swap it without
// touching the 26 call sites. onMutate fans events out to any
// collab plugin that called whenCollabReady (see collab-api.ts).
const onLocalMutationCallbacks = [];
wireMutations({
  scheduleSave: () => scheduleSave(),
  getMapPath: () => currentPath,
  onMutate: (e) => {
    for (const cb of onLocalMutationCallbacks) cb(e);
  },
});

wireClone({
  currentMap: () => state,
  selected,
  findTextById,
  findLineById,
  findImageById,
  mintId: uid,
});

wireAlign({
  canvas,
  currentMap: () => state,
  selected,
  getBoxEl,
  getTextEl,
  renderItems: (ids) => renderItems(ids),
});
attachAlignToolbar();

wireClipboard({
  selected,
  currentMap: () => state,
  findTextById,
  findLineById,
  findImageById,
  mintId: uid,
  renderItems: (ids) => renderItems(ids),
  deleteSelection: () => deleteSelection(),
  setStatus,
  clearSelectedEdge: () => { selectedEdge = null; },
});

wireBrush({
  mintId: () => uid("s"),
  strokeLayer: () => strokeLayer,
  currentMap: () => state,
  // Materialize just the committed stroke (#238); a discarded
  // too-short stroke changed nothing (brush.ts already removed its
  // preview polyline).
  afterCommit: (id) => { if (id) renderItems([id]); },
  setStatus,
});

wireLine({
  lineLayer: () => lineLayer,
  setStatus,
});

wireTextMode({
  setStatus,
});

wireDefaultShape({
  getGraph: () => graph,
  setStatus,
});

wireMedia({
  canvas,
  currentMap: () => state,
  mintId: uid,
  lastCursor,
  selected,
  clearSelectedEdge: () => { selectedEdge = null; },
  renderAll: () => renderAll(),
  setStatus,
});

wireMouse({
  canvas,
  ghostLine,
  currentMap: () => state,
  mintId: () => uid(),
  selected,
  lastCursor,
  drag: () => drag,
  setDrag: (d) => { drag = d; },
  link: () => link,
  setLink: (l) => { link = l; },
  pan: () => pan,
  setPan: (p) => { pan = p; },
  band: () => band,
  setBand: (b) => { band = b; },
  selectedEdge: () => selectedEdge,
  setSelectedEdge: (e) => { selectedEdge = e; },
  dropTargetId: () => dropTargetId,
  setDropTargetId: (id) => { dropTargetId = id; },
  dropTargetHandle: () => dropTargetHandle,
  setDropTargetHandle: (h) => { dropTargetHandle = h; },
  setStatus,
});
attachMouseListeners();

wireTouch({
  canvas,
  ghostLine,
  currentMap: () => state,
  findTextById,
  mintId: () => uid(),
  selected,
  drag: () => drag,
  setDrag: (d) => { drag = d; },
  pan: () => pan,
  setPan: (p) => { pan = p; },
  link: () => link,
  setLink: (l) => { link = l; },
  dropTargetId: () => dropTargetId,
  setDropTargetId: (id) => { dropTargetId = id; },
  dropTargetHandle: () => dropTargetHandle,
  setDropTargetHandle: (h) => { dropTargetHandle = h; },
  selectedEdge: () => selectedEdge,
  setSelectedEdge: (e) => { selectedEdge = e; },
});
attachTouchListeners();

wireKeys({
  canvas,
  ghostLine,
  currentMap: () => state,
  findTextById,
  selected,
  selectedEdge: () => selectedEdge,
  setSelectedEdge: (e) => { selectedEdge = e; },
  link: () => link,
  clearLink: () => { link = null; },
  setDropTargetId: (id) => { dropTargetId = id; },
  setDropTargetHandle: (h) => { dropTargetHandle = h; },
  clearProximity: () => clearProximity(),
  setStatus,
});
attachKeyboardListener();

attachMediaListeners();

// ---------------------------------------------------------------
// Toolbar buttons + window listeners + version stamp + initial load.
// ---------------------------------------------------------------

attachHelpListeners();

// Tag the body when the device's primary pointer is coarse (touch /
// stylus) so the help modal can swap its content (`.help-fine` vs
// `.help-coarse` in index.html). Reacts live so plugging / unplugging
// a mouse during the session updates the modal next time it opens.
const coarseMM = window.matchMedia("(pointer: coarse)");
const applyTouchClass = () =>
  document.body.classList.toggle("touch-input", coarseMM.matches);
coarseMM.addEventListener("change", applyTouchClass);
applyTouchClass();

// The bar itself is CSS-gated on `body.touch-input`, so attaching it
// unconditionally is safe — fine-pointer devices never see it.
wireContextBar({ selected, currentMap: () => state, applyShapeToSelection });
attachContextBar();

// Bottom-left zoom cluster (− / % / +); double-click on the
// percentage resets the view like Cmd/Ctrl+0.
attachZoomControl({ currentMap: () => state });

document.getElementById("upBtn").addEventListener("click", goUp);
document.getElementById("downloadBtn").addEventListener("click", downloadFlowgo);
document.getElementById("reshareBtn").addEventListener("click", reshare);

// Suppress middle-click autoscroll/paste so we can use it for navigation.
// (auxclick is suppressed inside attachMouseListeners.)
window.addEventListener(
  "mousedown",
  (e) => { if (e.button === 1) e.preventDefault(); },
  true,
);

// On window resize, recentre the map under the new viewport — view-only,
// no data mutation, so the file isn't dirtied. Suppress the URL sync
// so an incidental window resize doesn't overwrite the bookmarked
// view params with the recentre-driven pan offset.
window.addEventListener("resize", () => withSuppressedViewSync(recenter));

// Connect the live stream only after the initial load, so the first
// hello event has a revision baseline to compare itself against —
// otherwise the very first frame would look like news and cost a
// redundant /state round trip. Snapshot pages (/m/<id>) have no
// server-side document to follow.
load()
  .catch(() => { /* load() already reports its own failure */ })
  .then(() => { if (!SNAPSHOT_MODE) startLive(); });

fetch("/version")
  .then((r) => (r.ok ? r.text() : ""))
  .then((t) => {
    const v = t.trim();
    if (v) document.getElementById("version").textContent = "flowgo " + v;
  })
  .catch(() => { /* version stamp is best-effort */ });

// Expose the collab extension point. Plugins import whenCollabReady
// from "@flowgo/editor/collab"; nothing in the CLI / single-user
// bundle imports it so this is a no-op there.
exposeCollabHandle({
  snapshot: () => structuredClone(graph),
  applyRemotePatch: (fn) => {
    fn(graph);
    // A remote patch adds/removes items without going through
    // mutations.ts, so the memoized id cache has to be dropped here
    // explicitly or the next local mint could collide (#24f).
    invalidateUidCache();
    // The graph mutation may have changed the current map's contents
    // (or even removed it). Refresh the local `state` alias so the
    // next render reads the right slice.
    state = ensureMap(currentPath);
    renderAll();
  },
  onLocalMutation: (cb) => {
    onLocalMutationCallbacks.push(cb);
    return () => {
      const i = onLocalMutationCallbacks.indexOf(cb);
      if (i >= 0) onLocalMutationCallbacks.splice(i, 1);
    };
  },
});

