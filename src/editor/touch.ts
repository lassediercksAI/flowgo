// Single-finger touch gestures for mobile / tablets.
//
// Touch reuses the same drag / pan state as the mouse handlers, so
// only one gesture is ever live at a time. Differences from the mouse
// model:
//
//   1. Background drag pans the viewport instead of opening a rubber-
//      band selection. Marquee-select has no graceful single-finger
//      equivalent, and pan-on-bg is what every other mobile canvas
//      tool does.
//   2. A still tap on a box / text selects it (matches the mouseup-
//      without-movement branch in mouse.ts).
//   3. A double-tap on a box / text enters inline label editing
//      (touch equivalent of double-click in attach.ts).
//   4. A long press on a box (held still ~500ms) enters its submap
//      (touch equivalent of ⌘-click / middle-click in attach.ts).
//      Texts have no submap, so long-press there is a no-op and the
//      gesture falls through to whatever the user does next.
//
//   5. Two-finger pinch zooms the DATA VIEWPORT (brain#24c). This used
//      to be delegated to the browser via `touch-action: pinch-zoom`,
//      which zoomed the whole page — toolbar, mode bar and help modal
//      scaled along with the nodes, which is not what a canvas app
//      should do. The bottom-left zoom control already owns working
//      cursor-anchored zoom math (viewport.zoomAt), so pinch drives
//      the same viewport rather than a second pipeline: canvas content
//      scales, chrome stays put, and the percentage readout / min-max
//      clamps stay in agreement with the buttons and the wheel.
//      The math lives in pinch.ts (pure, unit-tested); this module
//      only owns the gesture lifecycle. Canvas surfaces therefore set
//      `touch-action: none` in index.html and we preventDefault iOS
//      Safari's non-standard `gesture*` events — but only for touches
//      that started on the canvas, so the help modal keeps browser
//      magnification for anyone who needs to enlarge the text.
//
// These listeners are bound to `document`, so every touch in the page
// passes through them — including touches meant for the chrome. A
// single region guard (onCanvasRegion, below) drops those before any
// branch can preventDefault them; on iOS a prevented touchstart
// suppresses the synthesized click, which is what left the feedback
// link and the help modal's close button dead (brain#256, brain#257).
//
// Link-drag from a handle dot mirrors the mouse path in attach.ts:
// on coarse pointers the handles are larger (CSS in index.html) and
// always shown for the selected box, since there is no hover. The
// proximity highlighter (render.ts) is fed the touch position during
// the drag so the same near-target glow appears.

import {
  abandonStroke,
  extendStroke,
  finishStroke,
  isBrushMode,
  isPainting,
  startStroke,
} from "./brush.ts";
import {
  cancelPendingLine,
  commitLineOnRelease,
  isDrawingLine,
  isLineMode,
  placeLinePoint,
  updateLinePreview,
} from "./line.ts";
import {
  applyViewport,
  flashZoomIndicator,
  toDataX,
  toDataY,
  viewport,
} from "./viewport.ts";
import { pinchAnchor, pinchViewport, type PinchAnchor } from "./pinch.ts";
import {
  applyClasses,
  clearProximity,
  renderAll,
  renderEdges,
  renderEdgesFor,
  updateCulling,
  updateProximity,
} from "./render.ts";
import { collectMovers } from "./attach.ts";
import { startEdit, startTextEdit } from "./edit.ts";
import { enterSubmap } from "./navigation.ts";
import { handleAnchor, nearestHandle, pickTargetHandle } from "./anchors.ts";
import { addOrReplaceEdge as addOrReplaceEdgePure } from "../graph/edge.ts";
import { findBoxAt } from "./mouse.ts";
import { createBoxAt, createTextAt, deleteSelection, spawnBoxForLinkDrop } from "./factories.ts";
import { getTextFont, getTextPalette, isTextMode, setTextMode } from "./text-mode.ts";
import { settleHexBoxes } from "./hex.ts";
import { mutatedCurrentMap, mutatedEdge } from "./mutations.ts";
import { classifyTap, movedBeyond, type TapRecord } from "./gestures.ts";
import { makeLineEndpointMover, type Mover } from "./movers.ts";

interface EdgeLike {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
}

interface BoxLike { id: string; label: string; x: number; y: number }
interface TextLike { id: string; label: string; x: number; y: number }
interface LineLike {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
  style?: number;
}
interface CurrentMap {
  boxes: BoxLike[];
  edges: EdgeLike[];
  texts: TextLike[];
  lines: LineLike[];
}

interface LinkState {
  fromId: string;
  fromHandle: string;
  startX: number;
  startY: number;
  handleEl: HTMLElement;
  rerouting?: boolean;
}

interface DragState {
  downX: number;
  downY: number;
  active: boolean;
  movers: Mover[];
  primaryId?: string;
  longPressFired?: boolean;
}

interface PanState {
  downX: number;
  downY: number;
  startVX: number;
  startVY: number;
}

interface TouchBindings {
  readonly canvas: HTMLElement;
  readonly ghostLine: SVGLineElement;
  readonly currentMap: () => CurrentMap;
  readonly findTextById: (id: string) => TextLike | undefined;
  readonly mintId: () => string;
  readonly selected: Set<string>;
  readonly drag: () => DragState | null;
  readonly setDrag: (d: DragState | null) => void;
  readonly pan: () => PanState | null;
  readonly setPan: (p: PanState | null) => void;
  readonly link: () => LinkState | null;
  readonly setLink: (l: LinkState | null) => void;
  readonly dropTargetId: () => string | null;
  readonly setDropTargetId: (id: string | null) => void;
  readonly dropTargetHandle: () => string | null;
  readonly setDropTargetHandle: (h: string | null) => void;
  readonly selectedEdge: () => EdgeLike | null;
  readonly setSelectedEdge: (e: EdgeLike | null) => void;
}

// Double-tap window — taps on the same target within this many ms
// promote to an edit gesture. 300ms is the historical iOS double-tap
// threshold and feels right next to native widgets.
const DOUBLE_TAP_MS = 300;
// Sentinel id for tracking taps on the empty canvas (bg). Wrapped in
// angle brackets so it can never collide with a real id.
const BG_TAP_ID = "<bg>";
// Long-press hold time before a still finger commits to "enter
// submap". 500ms matches the Android long-press default.
const LONG_PRESS_MS = 500;
// Movement above this many CSS pixels cancels the still-finger
// gestures (long-press, double-tap) and starts a drag instead.
const STILL_TOLERANCE_PX = 4;

let lastTap: TapRecord | null = null;
let longPressTimer: number | null = null;

const clearLongPressTimer = (): void => {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
};

// --- Pinch state (brain#24c) ------------------------------------------
//
// `pinch` is non-null exactly while two or more fingers are down on a
// canvas surface. `pinchFingers` is the finger count the anchor was
// captured with: any change (third finger down, one of three lifted)
// re-captures the anchor from the CURRENT viewport, so the canvas never
// jumps when the hand changes shape mid-gesture.
//
// `pinchTail` outlives the pinch itself. Lifting one finger of a pinch
// leaves the other one on the glass, and without this latch that
// survivor would immediately be read as a fresh single-finger gesture —
// panning the map, or painting a stroke across it in brush mode, right
// as the user finishes zooming. It clears only when every finger is up.
let pinch: PinchAnchor | null = null;
let pinchFingers = 0;
let pinchTail = false;

const beginPinch = (e: TouchEvent): void => {
  const a = e.touches[0];
  const b = e.touches[1];
  if (!a || !b) return;
  pinch = pinchAnchor(a.clientX, a.clientY, b.clientX, b.clientY, viewport);
  pinchFingers = e.touches.length;
  pinchTail = true;
  // A tap either side of a pinch must not pair up into a double-tap
  // (which would spawn a box or open the label editor after a zoom).
  lastTap = null;
  clearLongPressTimer();
};

const endPinch = (): void => {
  pinch = null;
  pinchFingers = 0;
};

// Delete drop zone — populated lazily so the editor still boots if
// #deleteZone is missing for any reason (e.g. embedded variant of the
// HTML).
const getDeleteZone = (): HTMLElement | null =>
  document.getElementById("deleteZone");

const isOverDeleteZone = (clientY: number): boolean => {
  const zone = getDeleteZone();
  if (!zone) return false;
  const r = zone.getBoundingClientRect();
  return clientY <= r.bottom;
};

const armDeleteZone = (armed: boolean): void => {
  const zone = getDeleteZone();
  zone?.classList.toggle("armed", armed);
};

let bindings: TouchBindings | null = null;
const must = (): TouchBindings => {
  if (!bindings) throw new Error("touch: wireTouch() not called");
  return bindings;
};

export const wireTouch = (b: TouchBindings): void => {
  bindings = b;
};

type TouchTarget =
  | { kind: "box"; el: HTMLElement; id: string }
  | { kind: "text"; el: HTMLElement; id: string }
  | {
      kind: "handle";
      boxEl: HTMLElement;
      boxId: string;
      handleEl: HTMLElement;
      code: string;
    }
  | {
      kind: "line-endpoint";
      lineId: string;
      endpoint: 1 | 2 | { mid: number };
    }
  | { kind: "line"; id: string }
  | { kind: "stroke"; id: string }
  | { kind: "bg" }
  | null;

const classifyTarget = (
  target: EventTarget | null,
  selected: ReadonlySet<string>,
): TouchTarget => {
  if (!(target instanceof Element)) return null;
  // Handle dot first — but ONLY when its parent box is selected. On
  // coarse pointers handles are invisible (opacity: 0) until the
  // box is selected, so accepting an invisible-handle touch would
  // start a connection from a target the user can't see. Falling
  // through to the box-body drag instead matches the visible UI.
  //
  // This gate and the coarse-pointer stylesheet are two halves of one
  // contract (brain#278): the CSS scopes the proximity reveal to fine
  // pointers precisely so that "visible" and "selected" cannot come
  // apart here. Widen either half without the other and the dot starts
  // lying again — either a visible dot that drags the box, or an
  // invisible one that starts a link.
  const handleEl = target.closest<HTMLElement>(".handle");
  if (handleEl) {
    const boxEl = handleEl.parentElement?.closest?.<HTMLElement>(".box") ?? null;
    if (boxEl && !boxEl.isContentEditable) {
      const boxId = boxEl.dataset["id"];
      const code = handleEl.dataset["handle"];
      if (boxId && code && selected.has(boxId)) {
        return { kind: "handle", boxEl, boxId, handleEl, code };
      }
    }
  }
  const box = target.closest<HTMLElement>(".box");
  if (box && !box.isContentEditable) {
    const id = box.dataset["id"];
    if (id) return { kind: "box", el: box, id };
  }
  const text = target.closest<HTMLElement>(".text-item");
  if (text && !text.isContentEditable) {
    const id = text.dataset["id"];
    if (id) return { kind: "text", el: text, id };
  }
  // Lines and strokes are SVG children of #bg-svg. Each line/stroke
  // group has its own .line-hit / .stroke-hit child (12px transparent
  // hit area, generous enough for a finger). The mouse path attaches
  // selection listeners directly to each group, but on touch we route
  // through this central classifier so the touch landing on the hit
  // area surfaces as a typed target before the bg fallback claims it
  // for pan.
  //
  // Line endpoint handles take priority over the line body — same idea
  // as box handles — but only when the parent line is already selected
  // (otherwise the handle is display:none and tapping there means the
  // user is reaching for the line body underneath).
  const lineHandle = target.closest<SVGCircleElement>(".line-handle");
  if (lineHandle) {
    const lineGroupOfHandle = lineHandle.closest<SVGGElement>(".line-group");
    const lineId = lineGroupOfHandle?.dataset?.["id"];
    const endpointStr = lineHandle.dataset["endpoint"];
    if (
      lineId &&
      selected.has(lineId) &&
      (endpointStr === "1" || endpointStr === "2" || endpointStr === "m")
    ) {
      let endpoint: 1 | 2 | { mid: number };
      if (endpointStr === "1") endpoint = 1;
      else if (endpointStr === "2") endpoint = 2;
      else {
        const idx = parseInt(lineHandle.dataset["midIndex"] ?? "0", 10);
        endpoint = { mid: Number.isFinite(idx) ? idx : 0 };
      }
      return { kind: "line-endpoint", lineId, endpoint };
    }
  }
  const lineGroup = target.closest<SVGGElement>(".line-group");
  if (lineGroup) {
    const id = lineGroup.dataset["id"];
    if (id) return { kind: "line", id };
  }
  const strokeGroup = target.closest<SVGGElement>(".stroke-group");
  if (strokeGroup) {
    const id = strokeGroup.dataset["id"];
    if (id) return { kind: "stroke", id };
  }
  // Bg-layer, the bg-svg (which wraps strokes + lines), and the edges
  // SVG all behave as "background" for touch — pan ignores them. On
  // mouse those each have their own click-to-select; on touch you'd
  // never hit a 2px stroke deliberately, so panning over them is the
  // useful default. Toolbar / help buttons sit outside these
  // containers and aren't swallowed.
  if (
    target.closest("#bg-layer") ||
    target.closest("#bg-svg") ||
    target.closest("#edges")
  ) {
    return { kind: "bg" };
  }
  return null;
};

// `discardStroke` distinguishes the two callers. On touchcancel the
// user meant to paint and the system interrupted them, so we commit
// what they drew (short strokes are dropped inside finishStroke). When
// a second finger lands they meant to pinch, and the millimetre of
// travel the first finger made before the second arrived must not be
// left on the canvas as a stray dot.
const abortGesture = (opts?: { readonly discardStroke?: boolean }): void => {
  const w = must();
  clearLongPressTimer();
  if (isPainting()) {
    if (opts?.discardStroke) abandonStroke();
    else finishStroke();
    return;
  }
  if (isDrawingLine()) {
    // Cancel a pending line endpoint rather than committing it at a
    // surprise location when a second finger arrives or the touch
    // sequence is cancelled.
    cancelPendingLine();
    return;
  }
  if (w.pan()) {
    w.setPan(null);
    document.body.classList.remove("panning");
  }
  const drag = w.drag();
  if (drag) {
    for (const m of drag.movers) m.el?.classList?.remove("dragging");
    w.setDrag(null);
    document.body.classList.remove("dragging");
    armDeleteZone(false);
  }
  const link = w.link();
  if (link) {
    link.handleEl.classList.remove("active");
    w.ghostLine.style.display = "none";
    w.setLink(null);
    if (w.dropTargetId() || w.dropTargetHandle()) {
      w.setDropTargetId(null);
      w.setDropTargetHandle(null);
      applyClasses();
    }
    clearProximity();
  }
};

// A pinch is ours to handle only when the fingers are on the canvas.
// Chrome (toolbar, mode bar, zoom control, help modal) returns null
// from classifyTarget, and there we deliberately leave the browser's
// own zoom alone — see the accessibility note in attachTouchListeners.
const onCanvasSurface = (target: EventTarget | null): boolean =>
  bindings !== null && classifyTarget(target, bindings.selected) !== null;

// Every drawable layer lives inside one of these. Chrome — #toolbar,
// #zoomCtl, #contextBar, #helpBtn, #helpOverlay, #live-notice — lives
// outside them, as a sibling on <body>.
const CANVAS_LAYERS = "#bg-layer, #bg-svg, #canvas, #edges";

// …with one exception: #alignToolbar is parked inside #canvas so the
// viewport transform carries it along with the selection. It is chrome
// wearing a canvas address.
const CANVAS_CHROME = "#alignToolbar";

// Is this touch ours at all? Answered by REGION, not by classifyTarget:
// classifyTarget returns null for plenty of things that are genuinely
// on the canvas (images, a box that is mid-inline-edit, dead space
// between layers), and a touch on any of those must still be able to
// start a brush stroke or a pan.
//
// This is the guard that keeps document-level preventDefault() away
// from the chrome. Without it every branch below that claims a touch —
// brush, line, pan, drag — would preventDefault a press on a toolbar
// button, and on iOS Safari a prevented touchstart suppresses the
// synthesized click, so the button silently does nothing. Scoping it
// here rather than per-element means the next control someone adds to
// the chrome is covered on the day it lands (brain#256 / brain#257).
//
// Only the START of a gesture is filtered. Once a canvas gesture is in
// flight, onTouchMove / onTouchEnd deliberately keep following the
// finger wherever it wanders, chrome included — a stroke or a drag
// must not break when it crosses the mode bar.
const onCanvasRegion = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest(CANVAS_LAYERS) !== null &&
  target.closest(CANVAS_CHROME) === null;

// True while a single-finger canvas gesture is live. If one is, the
// first finger is by definition on the canvas, so a second finger
// landing anywhere means the user is pinching the canvas.
const gestureInFlight = (): boolean => {
  const w = must();
  return (
    isPainting() ||
    isDrawingLine() ||
    w.pan() !== null ||
    w.drag() !== null ||
    w.link() !== null
  );
};

// Should this multi-touch sequence drive the data viewport? Evaluate
// BEFORE abortGesture(), which clears the in-flight state this reads.
const claimPinch = (e: TouchEvent): boolean =>
  pinchTail || gestureInFlight() || onCanvasSurface(e.target);

const onTouchStart = (e: TouchEvent): void => {
  if (e.touches.length >= 2) {
    // Second finger landed. Tear down whatever single-finger gesture is
    // in flight (discarding an in-progress stroke rather than committing
    // it), then take over as a pinch — unless the fingers are on chrome,
    // where the browser's own zoom still applies.
    const ours = claimPinch(e);
    // Only discard the in-flight stroke when WE take the gesture. If the
    // extra finger landed on chrome the user isn't pinching the canvas,
    // so the stroke keeps the old commit-on-interrupt behaviour.
    abortGesture({ discardStroke: ours });
    if (!ours) return;
    e.preventDefault();
    beginPinch(e);
    return;
  }
  // A finger came back down while the previous pinch's survivor is
  // still on the glass — still part of the same two-finger episode.
  if (pinchTail) return;
  // Tap-out ends editing: if a box / text label is in inline-edit
  // mode and this touch lands outside that element, blur it. The
  // blur handler in edit.ts commits the new label and exits edit
  // mode (which also dismisses the iOS keyboard). Runs for chrome
  // touches too — reaching for the help button mid-label should
  // commit the label, not strand it.
  const editing = document.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  );
  if (editing && !editing.contains(e.target as Node)) {
    editing.blur();
  }
  // Defensive: clear leftover drag-only chrome in case a previous
  // gesture ended without firing touchend (e.g. navigation or
  // visibility change interrupted it). The bar is only meant to
  // show during an *active* drag — never as ambient state.
  if (!document.body.classList.contains("panning")) {
    document.body.classList.remove("dragging");
    armDeleteZone(false);
  }
  // The touch landed on chrome, not on the map. Hands off entirely —
  // no preventDefault, no gesture — so the browser can turn it into
  // the click the button is listening for. See onCanvasRegion.
  if (!onCanvasRegion(e.target)) return;
  // Brush mode: a single-finger press anywhere on the canvas paints.
  // CSS already sets pointer-events: none on boxes/texts/lines/strokes/
  // edges while body.brush-mode is on, so the touch lands on #bg-layer
  // either way — but we still need to short-circuit the pan branch
  // below before it claims the gesture.
  if (isBrushMode()) {
    const t = e.touches[0]!;
    e.preventDefault();
    startStroke(t.clientX, t.clientY);
    return;
  }
  // Line mode: tap-to-set-start / drag-to-preview / lift-to-commit.
  // Mirrors the mouse path in mouse.ts. A still tap leaves `pending`
  // set so the next tap can commit the endpoint (tap-tap workflow).
  if (isLineMode()) {
    const t = e.touches[0]!;
    e.preventDefault();
    placeLinePoint(t.clientX, t.clientY);
    return;
  }
  const w = must();
  const t = e.touches[0]!;
  const target = classifyTarget(e.target, w.selected);
  if (!target) return;

  if (target.kind === "bg") {
    e.preventDefault();
    w.setPan({
      downX: t.clientX,
      downY: t.clientY,
      startVX: viewport.x,
      startVY: viewport.y,
    });
    document.body.classList.add("panning");
    return;
  }

  if (target.kind === "handle") {
    // Mirrors the handle branch of attachBoxHandlers in attach.ts —
    // either re-route an existing edge anchored to this handle, or
    // start a new connection from it.
    e.preventDefault();
    const map = w.currentMap();
    const b = map.boxes.find((x) => x.id === target.boxId);
    if (!b) return;

    let pickedEdge: EdgeLike | null = null;
    let anchoredId: string | null = null;
    let anchoredHandle = "";
    for (let i = map.edges.length - 1; i >= 0; i--) {
      const ed = map.edges[i]!;
      if (ed.from === target.boxId && ed.fromHandle === target.code) {
        pickedEdge = ed;
        anchoredId = ed.to;
        anchoredHandle = ed.toHandle ?? "";
        break;
      }
      if (ed.to === target.boxId && ed.toHandle === target.code) {
        pickedEdge = ed;
        anchoredId = ed.from;
        anchoredHandle = ed.fromHandle ?? "";
        break;
      }
    }

    if (pickedEdge && anchoredId) {
      const idx = map.edges.indexOf(pickedEdge);
      if (idx >= 0) map.edges.splice(idx, 1);
      const anchoredBox = map.boxes.find((x) => x.id === anchoredId);
      const anchoredEl = w.canvas.querySelector<HTMLElement>(
        `.box[data-id="${anchoredId}"]`,
      );
      if (!anchoredBox || !anchoredEl) {
        map.edges.push(pickedEdge);
        renderEdges();
        return;
      }
      const fallbackTowardX = b.x + target.boxEl.offsetWidth / 2;
      const fallbackTowardY = b.y + target.boxEl.offsetHeight / 2;
      const code2 =
        anchoredHandle ||
        nearestHandle(anchoredBox, anchoredEl, fallbackTowardX, fallbackTowardY);
      const [hx, hy] = handleAnchor(anchoredEl, anchoredBox, code2 as never);
      w.setLink({
        fromId: anchoredId,
        fromHandle: code2,
        startX: hx,
        startY: hy,
        handleEl: target.handleEl,
        rerouting: true,
      });
      target.handleEl.classList.add("active");
      w.ghostLine.setAttribute("x1", String(hx));
      w.ghostLine.setAttribute("y1", String(hy));
      w.ghostLine.setAttribute("x2", String(toDataX(t.clientX)));
      w.ghostLine.setAttribute("y2", String(toDataY(t.clientY)));
      w.ghostLine.style.display = "";
      renderEdges();
      return;
    }

    const [hx, hy] = handleAnchor(target.boxEl, b, target.code as never);
    // Anchor the ghost line at the handle dot's visual center, not at
    // the box edge and not at the touch point. The box edge leaves a
    // ~17px gap on coarse pointers (handles offset -28px); the touch
    // point drifts depending on where the finger lands inside the
    // 22px circle. The handle's bounding box is deterministic and is
    // exactly what the user sees — the line emerges from the dot.
    // link.startX/startY stay at the box-edge anchor so the on-drop
    // nearestHandle routing matches the mouse path exactly.
    const hr = target.handleEl.getBoundingClientRect();
    const ghostX1 = toDataX(hr.left + hr.width / 2);
    const ghostY1 = toDataY(hr.top + hr.height / 2);
    w.setLink({
      fromId: target.boxId,
      fromHandle: target.code,
      startX: hx,
      startY: hy,
      handleEl: target.handleEl,
    });
    target.handleEl.classList.add("active");
    w.ghostLine.setAttribute("x1", String(ghostX1));
    w.ghostLine.setAttribute("y1", String(ghostY1));
    w.ghostLine.setAttribute("x2", String(toDataX(t.clientX)));
    w.ghostLine.setAttribute("y2", String(toDataY(t.clientY)));
    w.ghostLine.style.display = "";
    return;
  }

  // Line endpoint drag — reshape a selected line by pulling one end.
  // Mirrors the endpoint branch of attachLineHandlers (mouse path).
  // The handle is display:none until the line is selected, so
  // classifyTarget only returns this kind when the user can see what
  // they're grabbing.
  if (target.kind === "line-endpoint") {
    const lineId = target.lineId;
    const endpoint = target.endpoint;
    const g = document.querySelector<SVGGElement>(
      `.line-group[data-id="${lineId}"]`,
    );
    const l = w.currentMap().lines.find((x) => x.id === lineId);
    if (!g || !l) return;
    const lineEl = g.querySelector<SVGPathElement>(".line-line");
    const hitEl = g.querySelector<SVGPathElement>(".line-hit");
    const h1 = g.querySelector<SVGCircleElement>(
      '.line-handle[data-endpoint="1"]',
    );
    const h2 = g.querySelector<SVGCircleElement>(
      '.line-handle[data-endpoint="2"]',
    );
    const midHandles = Array.from(
      g.querySelectorAll<SVGCircleElement>(
        '.line-handle[data-endpoint="m"]',
      ),
    );
    if (!lineEl || !hitEl || !h1 || !h2) return;
    e.preventDefault();
    w.selected.clear();
    w.selected.add(lineId);
    if (w.selectedEdge()) {
      w.setSelectedEdge(null);
      renderEdges();
    }
    applyClasses();
    w.setDrag({
      movers: [
        makeLineEndpointMover(l, endpoint, {
          g,
          line: lineEl,
          hit: hitEl,
          h1,
          h2,
          midHandles,
        }),
      ],
      primaryId: lineId,
      downX: t.clientX,
      downY: t.clientY,
      active: false,
    });
    return;
  }

  // Box / text / line / stroke body drag. Mirrors attachBoxHandlers /
  // attachTextHandlers / attachLineHandlers in src/editor/attach.ts,
  // minus the keyboard modifiers (shift / alt) that touch can't
  // express. Lines and strokes come through collectMovers via
  // makeLineMover / makeStrokeMover so they follow the finger and so a
  // drop in the delete zone removes them via the shared path.
  e.preventDefault();
  if (!w.selected.has(target.id)) {
    w.selected.clear();
    w.selected.add(target.id);
    if (w.selectedEdge()) {
      w.setSelectedEdge(null);
      renderEdges();
    }
    applyClasses();
  }
  w.setDrag({
    movers: collectMovers(),
    primaryId: target.id,
    downX: t.clientX,
    downY: t.clientY,
    active: false,
  });

  // Long-press → enter submap. Only meaningful for boxes; texts have
  // no submap, so skip the timer for them. Cancelled by movement
  // (touchmove >STILL_TOLERANCE_PX) and by touchend / touchcancel.
  if (target.kind === "box") {
    const boxId = target.id;
    longPressTimer = window.setTimeout(() => {
      longPressTimer = null;
      const drag = w.drag();
      if (!drag || drag.active) return;
      drag.longPressFired = true;
      // Snapshot ids before tearing the drag down — enterSubmap
      // re-renders and the drag's mover elements may not exist after.
      for (const m of drag.movers) m.el?.classList?.remove("dragging");
      w.setDrag(null);
      // Defensive: clear any drag-only chrome before navigating.
      // body.dragging shouldn't be set here (long-press only fires
      // while drag.active is false), but a stale class from a prior
      // interrupted gesture would otherwise persist into the submap
      // and leave the delete bar visible / hidden incorrectly.
      document.body.classList.remove("dragging");
      armDeleteZone(false);
      lastTap = null;
      enterSubmap(boxId);
    }, LONG_PRESS_MS);
  }
};

const onTouchMove = (e: TouchEvent): void => {
  const w = must();
  if (e.touches.length >= 2) {
    // Defensive: iOS can deliver a multi-touch move whose touchstart we
    // never saw (e.g. fingers landing inside the same frame while a
    // modal was closing). Capture a baseline rather than dropping the
    // gesture.
    if (!pinch) {
      const ours = claimPinch(e);
      abortGesture({ discardStroke: true });
      if (!ours) return;
      e.preventDefault();
      beginPinch(e);
      return;
    }
    e.preventDefault();
    // Finger count changed since the anchor was taken — re-baseline off
    // the current viewport so the scale doesn't step.
    if (e.touches.length !== pinchFingers) {
      beginPinch(e);
      return;
    }
    const a = e.touches[0]!;
    const b = e.touches[1]!;
    const next = pinchViewport(pinch, a.clientX, a.clientY, b.clientX, b.clientY);
    viewport.x = next.x;
    viewport.y = next.y;
    viewport.s = next.s;
    // One applyViewport per move event, exactly like the pan branch
    // below: a CSS transform write plus the culling hook, which is
    // rAF-throttled downstream (render.scheduleCullUpdate). No item is
    // re-rendered, so a pinch costs no element churn.
    applyViewport();
    flashZoomIndicator();
    return;
  }
  // Single finger left over from a pinch: swallow it. preventDefault
  // keeps iOS from reinterpreting the survivor as a page gesture.
  if (pinchTail) {
    e.preventDefault();
    return;
  }
  const t = e.touches[0];
  if (!t) return;

  if (isPainting()) {
    e.preventDefault();
    extendStroke(t.clientX, t.clientY);
    return;
  }
  if (isLineMode() && isDrawingLine()) {
    e.preventDefault();
    updateLinePreview(t.clientX, t.clientY);
    return;
  }

  const pan = w.pan();
  if (pan) {
    e.preventDefault();
    viewport.x = pan.startVX + (t.clientX - pan.downX);
    viewport.y = pan.startVY + (t.clientY - pan.downY);
    applyViewport();
    return;
  }

  const drag = w.drag();
  if (drag) {
    e.preventDefault();
    // Client-space delta (used for the drag-threshold check) vs
    // data-space delta (used to drive movers, which store data px).
    // At zoom != 1 the two diverge; movers want the data version.
    const cdx = t.clientX - drag.downX;
    const cdy = t.clientY - drag.downY;
    const sdx = cdx / viewport.s;
    const sdy = cdy / viewport.s;
    if (
      !drag.active &&
      movedBeyond(drag.downX, drag.downY, t.clientX, t.clientY, STILL_TOLERANCE_PX)
    ) {
      drag.active = true;
      // Movement defeats the long-press / double-tap timers — the
      // user is dragging now.
      clearLongPressTimer();
      lastTap = null;
      for (const m of drag.movers) m.el?.classList?.add("dragging");
      // Reveal the delete drop zone for the duration of the drag.
      document.body.classList.add("dragging");
    }
    if (drag.active) {
      // Touch has no shift key — pass null so movers skip grid snap.
      for (const m of drag.movers) m.apply(sdx, sdy, null);
      // Re-route only the dragged boxes' incident edges (#238),
      // mirroring mouse.ts's drag branch.
      renderEdgesFor(w.selected);
      armDeleteZone(isOverDeleteZone(t.clientY));
    }
    return;
  }

  const link = w.link();
  if (link) {
    e.preventDefault();
    const dx = toDataX(t.clientX);
    const dy = toDataY(t.clientY);
    w.ghostLine.setAttribute("x2", String(dx));
    w.ghostLine.setAttribute("y2", String(dy));
    const tgt = findBoxAt(t.clientX, t.clientY);
    const id = tgt && tgt.dataset["id"] !== link.fromId
      ? tgt.dataset["id"] ?? null
      : null;
    let handleCode: string | null = null;
    if (id && tgt) {
      const map = w.currentMap();
      const tBox = map.boxes.find((b) => b.id === id);
      if (tBox) {
        handleCode = pickTargetHandle(
          tgt,
          tBox,
          t.clientX,
          t.clientY,
        );
      }
    }
    if (id !== w.dropTargetId() || handleCode !== w.dropTargetHandle()) {
      w.setDropTargetId(id);
      w.setDropTargetHandle(handleCode);
      applyClasses();
    }
    updateProximity(dx, dy);
  }
};

const onTouchEnd = (e: TouchEvent): void => {
  const w = must();
  clearLongPressTimer();

  if (pinchTail) {
    // Still ≥2 fingers down (a third was lifted) — keep pinching, but
    // re-baseline for the new hand shape.
    if (e.touches.length >= 2) {
      beginPinch(e);
      return;
    }
    endPinch();
    // The last finger is up: the episode is over and normal gestures
    // resume with the next touchstart. Until then every remaining
    // finger stays inert.
    if (e.touches.length === 0) {
      pinchTail = false;
      lastTap = null;
      // Materialize anything the zoom brought into view. applyViewport
      // already scheduled a rAF cull pass per move; this is the same
      // belt-and-braces call the drag-end path makes.
      updateCulling();
    }
    return;
  }

  if (isPainting()) {
    finishStroke();
    return;
  }
  if (isLineMode() && isDrawingLine()) {
    const t = e.changedTouches[0];
    if (t) commitLineOnRelease(t.clientX, t.clientY);
    return;
  }

  const pan = w.pan();
  if (pan) {
    const t = e.changedTouches[0] ?? null;
    const moved =
      t !== null &&
      movedBeyond(pan.downX, pan.downY, t.clientX, t.clientY, STILL_TOLERANCE_PX);
    w.setPan(null);
    document.body.classList.remove("panning");
    if (!moved && t) {
      // Text mode (armed from the mode bar): a SINGLE tap places the
      // text item, mirroring the single-click path in mouse.ts
      // onBgMouseDown. Single-shot — the mode exits before the spawn.
      if (isTextMode()) {
        setTextMode(false);
        createTextAt(toDataX(t.clientX), toDataY(t.clientY), getTextPalette(), getTextFont());
        lastTap = null;
        return;
      }
      // Tap on empty canvas. Single tap clears the current selection
      // (touch parallel of mouse.ts onBgMouseDown) so the user can
      // get out of "this box is selected" without dragging away.
      // Two taps within DOUBLE_TAP_MS spawn a new box at the second
      // tap (touch parallel of mouse.ts onBgDblClick).
      const tap = classifyTap(
        lastTap,
        { id: BG_TAP_ID, time: performance.now() },
        DOUBLE_TAP_MS,
      );
      lastTap = tap.nextLastTap;
      if (tap.kind === "double") {
        const dx = toDataX(t.clientX);
        const dy = toDataY(t.clientY);
        createBoxAt(dx, dy, { x: dx, y: dy });
      } else if (w.selected.size > 0 || w.selectedEdge()) {
        w.selected.clear();
        if (w.selectedEdge()) {
          w.setSelectedEdge(null);
          renderEdges();
        }
        applyClasses();
      }
    } else {
      lastTap = null;
    }
    return;
  }

  const link = w.link();
  if (link) {
    finalizeLink(link, e.changedTouches[0] ?? null);
    return;
  }

  const drag = w.drag();
  if (!drag) return;

  const wasActive = drag.active;
  const longPressed = drag.longPressFired === true;
  for (const m of drag.movers) m.el?.classList?.remove("dragging");
  const primaryId = drag.primaryId;
  w.setDrag(null);

  // Hide delete drop zone — it only shows during an active drag.
  document.body.classList.remove("dragging");
  const armed = getDeleteZone()?.classList.contains("armed") ?? false;
  armDeleteZone(false);

  if (longPressed) return; // already handled in the timer
  if (wasActive) {
    if (armed) {
      // Drop in the delete zone removes everything currently selected
      // (deleteSelection handles boxes, texts, lines, strokes, plus
      // any submap subtrees attached to deleted boxes).
      deleteSelection();
      lastTap = null;
      return;
    }
    // Hexagons must never overlap — settle any hex the drag landed on
    // an occupied spot onto a free lattice cell (mirrors mouse.ts).
    if (settleHexBoxes(w.currentMap().boxes)) renderAll();
    mutatedCurrentMap();
    // Re-evaluate culling for items dragged across the
    // materialization boundary (mirrors mouse.ts drag end).
    updateCulling();
    lastTap = null;
    return;
  }

  // Tap without movement. Single tap → collapse selection (mirrors
  // mouseup-without-movement in mouse.ts). Second tap on the same
  // target inside DOUBLE_TAP_MS → enter inline label edit.
  if (!primaryId) return;
  const tap = classifyTap(
    lastTap,
    { id: primaryId, time: performance.now() },
    DOUBLE_TAP_MS,
  );
  lastTap = tap.nextLastTap;
  if (tap.kind === "double") {
    const map = w.currentMap();
    const box = map.boxes.find((b) => b.id === primaryId);
    if (box) {
      const el = document.querySelector<HTMLElement>(
        `#canvas .box[data-id="${primaryId}"]`,
      );
      if (el) {
        w.selected.clear();
        w.selected.add(primaryId);
        if (w.selectedEdge()) {
          w.setSelectedEdge(null);
          renderEdges();
        }
        applyClasses();
        startEdit(el, box);
      }
      return;
    }
    const text = w.findTextById(primaryId);
    if (text) {
      const el = document.querySelector<HTMLElement>(
        `#canvas .text-item[data-id="${primaryId}"]`,
      );
      if (el) {
        w.selected.clear();
        w.selected.add(primaryId);
        applyClasses();
        startTextEdit(el, text);
      }
      return;
    }
    return;
  }

  w.selected.clear();
  w.selected.add(primaryId);
  if (w.selectedEdge()) {
    w.setSelectedEdge(null);
    renderEdges();
  }
  applyClasses();
};

// Mirrors the link branch of onMouseUp in mouse.ts. Either drops the
// connection on a target box (or one of its handles) or — if the
// touch is released over empty space — spawns a new box at that
// point and connects to it.
const finalizeLink = (link: LinkState, t: Touch | null): void => {
  const w = must();
  link.handleEl.classList.remove("active");
  w.ghostLine.style.display = "none";
  if (!t) {
    w.setLink(null);
    if (w.dropTargetId() || w.dropTargetHandle()) {
      w.setDropTargetId(null);
      w.setDropTargetHandle(null);
      applyClasses();
    }
    clearProximity();
    return;
  }
  const tgt = findBoxAt(t.clientX, t.clientY);
  if (tgt && tgt.dataset["id"] !== link.fromId) {
    const toId = tgt.dataset["id"]!;
    const map = w.currentMap();
    const targetBox = map.boxes.find((bx) => bx.id === toId)!;
    const toCode = pickTargetHandle(
      tgt,
      targetBox,
      t.clientX,
      t.clientY,
    );
    const newEdge: EdgeLike = { from: link.fromId, to: toId };
    if (link.fromHandle) newEdge.fromHandle = link.fromHandle;
    if (toCode) newEdge.toHandle = toCode;
    map.edges = addOrReplaceEdgePure(map.edges, newEdge);
    mutatedEdge();
    renderEdges();
  } else {
    // Empty-space drop: spawn (hex-aware, mirrors the mouse path)
    // and connect. spawnBoxForLinkDrop leaves the commit to us so
    // box + edge land as one undo step.
    const spawned = spawnBoxForLinkDrop(toDataX(t.clientX), toDataY(t.clientY));
    if (spawned) {
      const { box: newBox, el: newEl } = spawned;
      const map = w.currentMap();
      const toCode = nearestHandle(newBox, newEl, link.startX, link.startY);
      const newEdge: EdgeLike = { from: link.fromId, to: newBox.id };
      if (link.fromHandle) newEdge.fromHandle = link.fromHandle;
      if (toCode) newEdge.toHandle = toCode;
      map.edges = addOrReplaceEdgePure(map.edges, newEdge);
      renderEdges();
      w.selected.clear();
      w.selected.add(newBox.id);
      applyClasses();
      startEdit(newEl, newBox, { cancelDeletes: true });
    }
    mutatedCurrentMap();
  }
  w.setLink(null);
  if (w.dropTargetId() || w.dropTargetHandle()) {
    w.setDropTargetId(null);
    w.setDropTargetHandle(null);
    applyClasses();
  }
  clearProximity();
};

const onTouchCancel = (e: TouchEvent): void => {
  if (pinchTail) {
    endPinch();
    if (e.touches.length === 0) pinchTail = false;
    lastTap = null;
    return;
  }
  abortGesture();
  lastTap = null;
};

// iOS Safari's non-standard gesturestart / gesturechange / gestureend.
// `touch-action: none` is the standards-track lever and does the real
// work, but Safari has historically kept its own pinch alive through
// touch-action in a few situations (notably standalone / home-screen
// mode), and preventDefault on these is the documented way to stop it.
// Cheap belt-and-braces; harmless everywhere else since no other engine
// fires them.
//
// Deliberately scoped to canvas surfaces. Anything else — most
// importantly the help modal, which is a wall of small text — keeps the
// browser's own magnification. A page that is `touch-action: none`
// end-to-end traps low-vision users with no way to enlarge text, and
// the canvas doesn't need that trade because it has its own zoom (with
// a visible percentage and 50–800% clamps) bound to the same gesture.
const onGesture = (e: Event): void => {
  if (!onCanvasSurface(e.target)) return;
  e.preventDefault();
};

export const attachTouchListeners = (): void => {
  // passive: false because we call preventDefault() to keep the page
  // from scrolling / zooming under the gesture.
  document.addEventListener("touchstart", onTouchStart, { passive: false });
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd);
  document.addEventListener("touchcancel", onTouchCancel);
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, onGesture, { passive: false });
  }
};
