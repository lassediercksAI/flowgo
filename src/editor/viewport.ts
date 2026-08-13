// Viewport: pan offset + zoom scale + the small bundle of helpers
// that translate between screen and canvas-data coordinates and
// reposition / re-scale every canvas-aligned layer when the viewport
// moves.
//
// The viewport object is exported as a stable mutable reference so
// pan / drag / undo handlers can write to `viewport.x` / `.y` / `.s`
// and then call applyViewport() to redraw — keeps the live-binding
// semantics callers expect from the previous module-global.
//
// Transform model: `transform: translate(x, y) scale(s)` with
// `transform-origin: 0 0`. A point at data position (dx, dy) lands at
// screen position (x + dx*s, y + dy*s), which inverts to
// dataX = (clientX - x) / s — the formula in toDataX/toDataY below.

export const viewport: { x: number; y: number; s: number } = {
  x: 0,
  y: 0,
  s: 1,
};

// Zoom bounds. The floor is 50% — past that, boxes and edges shrink
// into illegible specks and panning loses precision; 8x is past
// "I want to read tiny text" into "I want pixel-level positioning"
// territory. Outside this window, transforms start hitting CSS
// subpixel-rounding artefacts.
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 8;

export const clampScale = (s: number): number =>
  Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

export const toDataX = (clientX: number): number =>
  (clientX - viewport.x) / viewport.s;
export const toDataY = (clientY: number): number =>
  (clientY - viewport.y) / viewport.s;

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`viewport: missing #${id}`);
  return el;
};

// Grid spacing in data units — matches the two `background-size`
// pairs declared in index.html (20px minor, 100px major). Scaling
// these by viewport.s keeps the grid visually anchored to the
// canvas content rather than the screen, so zooming "in" makes the
// dots spread apart instead of staying still.
const GRID_MINOR = 20;
// Exported for the wheel-notch pan step in mouse.ts: one notch pans
// exactly one major grid block so the background pattern maps onto
// itself after every notch.
export const GRID_MAJOR = 100;

export const applyViewport = (): void => {
  const { x: tx, y: ty, s } = viewport;
  // `translate ... scale` with `transform-origin: 0 0` is set on
  // #canvas via inline style; the SVG layers use the `transform`
  // attribute with the same convention. Order matters: scale first
  // (around origin), then translate by an un-scaled offset.
  byId("canvas").style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  // Edge labels are HTML in their own layer (they're contenteditable,
  // which SVG <text> is not), so they need the same CSS transform the
  // canvas gets rather than the SVG `transform` attribute below.
  byId("edge-label-layer").style.transform =
    `translate(${tx}px, ${ty}px) scale(${s})`;
  for (const layer of ["line-layer", "stroke-layer", "edge-layer"]) {
    byId(layer).setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
  }
  byId("ghost-line").setAttribute(
    "transform",
    `translate(${tx} ${ty}) scale(${s})`,
  );
  const bg = byId("bg-layer");
  bg.style.backgroundPosition = `${tx}px ${ty}px`;
  const minor = GRID_MINOR * s;
  const major = GRID_MAJOR * s;
  bg.style.backgroundSize =
    `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`;
  // Unlike viewChanged, the display hook fires even while view sync is
  // suppressed — the zoom control must reflect a load-time / resize
  // scale change even though the URL shouldn't.
  displayChanged?.();
  // Culling must track EVERY transform change (suspended or not): a
  // load-time recenter moves the data-space viewport just as much as a
  // user pan does. The callback is rAF-throttled downstream
  // (render.scheduleCullUpdate), so per-wheel-event invocation is fine.
  cullChanged?.();
  if (viewSyncSuspended === 0) viewChanged?.();
};

// Cursor-anchored zoom: solve for a new viewport.x/y such that the
// data point currently under (clientX, clientY) stays under it after
// the scale change. This is what Figma / Miro / browser canvases do
// and what every user expects from pinch-to-zoom.
//
// The indicator is flashed even when the requested scale was clamped
// (target === viewport.s) so the user can see *why* further zoom
// didn't take effect — the toast shows "50% (min)" or "800% (max)"
// with a red outline.
export const zoomAt = (
  clientX: number,
  clientY: number,
  newScale: number,
): void => {
  const target = clampScale(newScale);
  if (target !== viewport.s) {
    const dataX = toDataX(clientX);
    const dataY = toDataY(clientY);
    viewport.s = target;
    viewport.x = clientX - dataX * target;
    viewport.y = clientY - dataY * target;
    applyViewport();
  }
  flashZoomIndicator();
};

// Reset to 100% and recenter on the anchor — the Cmd/Ctrl+0 behaviour,
// shared with the zoom control's double-click. The viewport.s = 1
// assignment goes before recenter() because recenter's translate math
// reads viewport.s — at the new scale, not the old one.
export const resetZoom = (map: Parameters<typeof recenter>[0]): void => {
  viewport.s = 1;
  recenter(map);
  flashZoomIndicator();
};

// Transient zoom-percentage toast. The indicator stays visible for
// INDICATOR_TTL_MS after the most recent zoom; rapid wheel ticks
// keep refreshing the timer so the toast persists for the duration
// of the gesture and only fades once the user lets go.
const INDICATOR_TTL_MS = 1200;
let indicatorEl: HTMLElement | null = null;
let indicatorTimer: number | null = null;
export const flashZoomIndicator = (): void => {
  if (!indicatorEl) indicatorEl = document.getElementById("zoom-indicator");
  if (!indicatorEl) return;
  const pct = Math.round(viewport.s * 100);
  const atMin = viewport.s <= MIN_SCALE + 1e-6;
  const atMax = viewport.s >= MAX_SCALE - 1e-6;
  indicatorEl.textContent = atMin
    ? `${pct}% (min)`
    : atMax
    ? `${pct}% (max)`
    : `${pct}%`;
  indicatorEl.classList.toggle("at-min", atMin);
  indicatorEl.classList.toggle("at-max", atMax);
  indicatorEl.classList.add("visible");
  if (indicatorTimer !== null) clearTimeout(indicatorTimer);
  indicatorTimer = window.setTimeout(() => {
    indicatorEl?.classList.remove("visible");
    indicatorTimer = null;
  }, INDICATOR_TTL_MS);
};

// The map shape recenter() reads. Exported so the pure helpers below
// can share it with recenter's signature.
export interface RecenterMap {
  readonly boxes?: ReadonlyArray<{
    readonly id?: string;
    readonly x: number;
    readonly y: number;
    readonly anchor?: boolean;
  }>;
  readonly texts?: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly lines?: ReadonlyArray<{
    readonly x1: number; readonly y1: number;
    readonly x2: number; readonly y2: number;
    readonly mids?: ReadonlyArray<readonly [number, number]>;
  }>;
}

// Pure target selection for recenter(). Priority order:
//   1. The map's anchor box (the one with `anchor: true`).
//   2. A box with id "b1" — the conventional first box (back-compat
//      so older maps without an explicit anchor still centre nicely).
//   3. The first box on the map — gives Cmd+0 a predictable landing
//      spot on maps that never had an anchor designated.
export const recenterTarget = (
  boxes: NonNullable<RecenterMap["boxes"]>,
): NonNullable<RecenterMap["boxes"]>[number] | undefined =>
  boxes.find((b) => b.anchor) ??
  boxes.find((b) => b.id === "b1") ??
  boxes[0];

// Pure bounding-box centre of every concrete piece on the map — box
// top-lefts, text anchors, line endpoints and midpoints. Null when the
// map holds nothing to centre on.
export const contentCenter = (
  currentMap: RecenterMap,
): readonly [number, number] | null => {
  const points: Array<readonly [number, number]> = [];
  for (const b of currentMap.boxes ?? []) points.push([b.x, b.y]);
  for (const t of currentMap.texts ?? []) points.push([t.x, t.y]);
  for (const l of currentMap.lines ?? []) {
    points.push([l.x1, l.y1]);
    points.push([l.x2, l.y2]);
    for (const [mx, my] of l.mids ?? []) points.push([mx, my]);
  }
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
};

// Centre the camera on recenterTarget(), falling back to
// contentCenter() when no targetable box exists.
// Side effects: mutates `viewport` and replays applyViewport.
//
// Recenter does NOT change viewport.s — zoom is sticky across
// navigation. Only the translate is recomputed.
export const recenter = (currentMap: RecenterMap): void => {
  const s = viewport.s;
  const target = recenterTarget(currentMap.boxes ?? []);
  if (target && target.id) {
    // Prefer the rendered element's true centre; fall back to the
    // stored top-left (matches existing bbox math for single-point
    // maps) if the element isn't in the DOM yet.
    const el = document.querySelector<HTMLElement>(
      `.box[data-id="${target.id}"]`,
    );
    const cx = target.x + (el ? el.offsetWidth / 2 : 0);
    const cy = target.y + (el ? el.offsetHeight / 2 : 0);
    viewport.x = window.innerWidth / 2 - cx * s;
    viewport.y = window.innerHeight / 2 - cy * s;
    applyViewport();
    return;
  }

  const centre = contentCenter(currentMap);
  if (centre === null) {
    viewport.x = 0;
    viewport.y = 0;
  } else {
    viewport.x = window.innerWidth / 2 - centre[0] * s;
    viewport.y = window.innerHeight / 2 - centre[1] * s;
  }
  applyViewport();
};

// Hook for URL persistence. wireViewportSync() lets navigation.ts
// install a callback that fires (debounced inside the callback)
// whenever pan/zoom changes — applyViewport() invokes it on every
// redraw. Kept here so viewport.ts owns the "view changed" signal
// without depending on navigation.ts.
//
// `viewSyncSuspended` lets non-user-driven redraws (e.g. window.resize
// → recenter, initial load layout) push the transform without
// stomping a bookmarked URL. Callers wrap their work in
// withSuppressedViewSync().
let viewChanged: (() => void) | null = null;
let viewSyncSuspended = 0;
export const wireViewportSync = (cb: () => void): void => {
  viewChanged = cb;
};
// Second, independent slot for UI that mirrors the viewport (the zoom
// control's percentage readout). Invoked once at wiring so the readout
// starts correct without waiting for the first pan/zoom.
let displayChanged: (() => void) | null = null;
export const wireViewportDisplay = (cb: () => void): void => {
  displayChanged = cb;
  cb();
};
// Third slot: viewport culling (brain#23a). Pan/zoom is a pure CSS
// transform — no re-render — so the renderer needs its own signal to
// re-evaluate which items deserve DOM. Kept as a separate slot (not
// piggybacked on displayChanged) so wiring order and the fire-while-
// suspended semantics stay independent.
let cullChanged: (() => void) | null = null;
export const wireViewportCullHook = (cb: () => void): void => {
  cullChanged = cb;
};
export const withSuppressedViewSync = <T>(fn: () => T): T => {
  viewSyncSuspended++;
  try {
    return fn();
  } finally {
    viewSyncSuspended--;
  }
};
