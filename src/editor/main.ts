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
  collectIds,
  hasSubmapContent,
  nextUid,
  serializeGraph as serializeGraphPure,
} from "../index.ts";

import { attachHelpListeners } from "./help.ts";
import {
  recenter as recenterPure,
} from "./viewport.ts";
import { isBrushMode, wireBrush } from "./brush.ts";
import { wireLine } from "./line.ts";
import { wireClipboard } from "./clipboard.ts";
import {
  attachNavigationListeners,
  ensureMap,
  goUp,
  navigateTo,
  readPathFromURL,
  wireNavigation,
} from "./navigation.ts";
import {
  downloadFlowgo,
  load,
  reshare,
  scheduleSave,
  wirePersistence,
} from "./persistence.ts";
import { mutatedCurrentMap, wireMutations } from "./mutations.ts";
import {
  cloneSelection as cloneSelectionPure,
  wireClone,
} from "./clone.ts";
import { wireEdit } from "./edit.ts";
import {
  applyClasses,
  clearProximity,
  renderAll,
  renderStrokes,
  wireProximity,
  wireRender,
} from "./render.ts";
import { deleteSelection, wireFactories } from "./factories.ts";
import { attachKeyboardListener, wireKeys } from "./keys.ts";
import { attachMouseListeners, wireMouse } from "./mouse.ts";
import { attachTouchListeners, wireTouch } from "./touch.ts";
import {
  attachBoxHandlers,
  attachLineHandlers,
  attachTextHandlers,
  wireAttach,
} from "./attach.ts";
import { attachAlignToolbar, wireAlign } from "./align.ts";
import { attachModeBar } from "./modebar.ts";

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

function uid(prefix) {
  return nextUid(prefix || "b", collectIds(
    state.boxes,
    state.texts || [],
    state.lines || [],
    state.strokes || [],
  ));
}

const findTextById = (id) => state.texts.find((t) => t.id === id);
const findLineById = (id) => state.lines.find((l) => l.id === id);
const findStrokeById = (id) => (state.strokes || []).find((s) => s.id === id);

const recenter = () => recenterPure(state);

function setStatus(_s) {
  // Status hint area was removed; keep callers harmless.
}

// cloneSelection wraps the pure clone with the render + save trail
// the existing call sites expect.
function cloneSelection() {
  const idMap = cloneSelectionPure();
  renderAll();
  applyClasses();
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
  attachLineHandlers,
  isBrushMode: () => isBrushMode(),
  setStatus,
});

wireProximity({
  canvas,
  currentMap: () => state,
  link: () => link,
  nearTargetId: () => nearTargetId,
  setNearTargetId: (id) => { nearTargetId = id; },
});

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
  setStatus,
});

wirePersistence({
  getGraph: () => graph,
  setGraph: (g) => { graph = g; },
  serializeGraph: serializeGraphPure,
  setCurrentPath: (p, opts) => navigateTo(p, opts),
  getCurrentPath: () => currentPath,
  readPathFromURL,
  setStatus,
  clearSelected: () => selected.clear(),
  clearSelectedEdge: () => { selectedEdge = null; },
});

// Every mutation funnels through mutations.ts. The default wiring
// just calls scheduleSave; downstream consumers can swap it without
// touching the 26 call sites.
wireMutations({ scheduleSave: () => scheduleSave() });

wireClone({
  currentMap: () => state,
  selected,
  findTextById,
  findLineById,
  mintId: uid,
});

wireAlign({
  canvas,
  currentMap: () => state,
  selected,
  renderAll: () => renderAll(),
});
attachAlignToolbar();

wireClipboard({
  selected,
  currentMap: () => state,
  findTextById,
  findLineById,
  mintId: uid,
  renderAll: () => renderAll(),
  deleteSelection: () => deleteSelection(),
  setStatus,
  clearSelectedEdge: () => { selectedEdge = null; },
});

wireBrush({
  mintId: () => uid("s"),
  strokeLayer: () => strokeLayer,
  currentMap: () => state,
  afterCommit: () => renderStrokes(),
  setStatus,
});

wireLine({
  lineLayer: () => lineLayer,
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
  lastCursor,
  setStatus,
});
attachKeyboardListener();

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
attachModeBar();

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
// no data mutation, so the file isn't dirtied.
window.addEventListener("resize", () => recenter());

load();

fetch("/version")
  .then((r) => (r.ok ? r.text() : ""))
  .then((t) => {
    const v = t.trim();
    if (v) document.getElementById("version").textContent = "flowgo " + v;
  })
  .catch(() => { /* version stamp is best-effort */ });

