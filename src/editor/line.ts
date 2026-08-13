// Line-draw mode: click to set the start point, click again to set
// the end point and commit the line. Mode stays on so the user can
// chain multiple lines; L toggles it off and Escape exits.
//
// main.ts wires this and mouse.ts checks `isLineMode()` to route bg
// clicks here instead of starting a rubber-band selection.

import { createLineSegment } from "./factories.ts";
import { toDataX, toDataY } from "./viewport.ts";

interface LineBindings {
  readonly lineLayer: () => SVGGElement;
  readonly setStatus: (s: string) => void;
}

let bindings: LineBindings | null = null;
const must = (): LineBindings => {
  if (!bindings) throw new Error("line: wireLine() not called");
  return bindings;
};

export const wireLine = (b: LineBindings): void => {
  bindings = b;
};

let lineMode = false;

// Pending style for the NEXT drawn line — mirrors brush.ts's palette.
// Surfaced in the touch context bar (contextbar.ts).
let pendingPalette = 1;
let pendingStyle = 1;

export const getLinePalette = (): number => pendingPalette;
export const setLinePalette = (p: number): void => {
  if (p < 1 || p > 9) return;
  pendingPalette = p;
};

export const getLineStyle = (): number => pendingStyle;
export const setLineStyle = (s: number): void => {
  if (s < 1 || s > 9) return;
  pendingStyle = s;
};

let pending: { x: number; y: number } | null = null;
// Client-coord snapshot of the mousedown that set `pending`, used to
// distinguish a click (release near the down point → keep pending,
// await next click) from a drag (release far away → commit on up).
let pendingDownClient: { x: number; y: number } | null = null;
let previewEl: SVGLineElement | null = null;

export const isLineMode = (): boolean => lineMode;
export const isDrawingLine = (): boolean => pending !== null;

const ensurePreview = (): SVGLineElement => {
  if (previewEl) return previewEl;
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "line");
  el.setAttribute("class", "line-preview");
  el.setAttribute("stroke", "#07f");
  el.setAttribute("stroke-width", "2");
  el.setAttribute("stroke-dasharray", "5 4");
  el.style.pointerEvents = "none";
  must().lineLayer().appendChild(el);
  previewEl = el;
  return el;
};

const removePreview = (): void => {
  if (previewEl && previewEl.parentNode) {
    previewEl.parentNode.removeChild(previewEl);
  }
  previewEl = null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Pure geometry (exported for direct testing) ─────────────────

// Snap (x, y) onto the ray from `start` whose angle is the nearest
// multiple of 10°, preserving the cursor's distance from the start.
export const snapAngle = (
  start: { x: number; y: number },
  x: number,
  y: number,
): { x: number; y: number } => {
  const dx = x - start.x;
  const dy = y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.001) return { x, y };
  const step = (10 * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: round2(start.x + Math.cos(snapped) * dist),
    y: round2(start.y + Math.sin(snapped) * dist),
  };
};

// Where the line's free endpoint lands for a cursor at (rawX, rawY):
// shift constrains to the nearest 10° ray from `start`, otherwise the
// cursor position is taken as-is. Single seam shared by the preview,
// the click-click commit, and the drag-release commit so all three
// resolve identically.
export const resolveLineEnd = (
  start: { x: number; y: number },
  rawX: number,
  rawY: number,
  shiftKey: boolean,
): { x: number; y: number } =>
  shiftKey ? snapAngle(start, rawX, rawY) : { x: rawX, y: rawY };

// A would-be line under 2 DATA units is treated as an accidental
// click and cancels rather than committing a speck.
export const isNegligibleLine = (
  start: { x: number; y: number },
  end: { x: number; y: number },
): boolean => Math.hypot(end.x - start.x, end.y - start.y) < 2;

// A release less than 4 CLIENT px from the mousedown that set the
// start point is a click (keep pending, await the second click);
// anything further is a drag and commits on release. Client px, not
// data units — the click/drag distinction is about finger/mouse
// travel, which zooming must not change.
export const isDragRelease = (
  down: { x: number; y: number },
  upClientX: number,
  upClientY: number,
): boolean => Math.hypot(upClientX - down.x, upClientY - down.y) >= 4;

export const setLineMode = (on: boolean): void => {
  if (lineMode === on) return;
  lineMode = on;
  document.body.classList.toggle("line-mode", lineMode);
  if (!lineMode) {
    pending = null;
    pendingDownClient = null;
    removePreview();
  }
  must().setStatus(
    lineMode
      ? "line mode — click start, click end · L or Escape to exit"
      : "select mode",
  );
};

export const cancelPendingLine = (): void => {
  if (!pending) return;
  pending = null;
  pendingDownClient = null;
  removePreview();
};

export const placeLinePoint = (
  clientX: number,
  clientY: number,
  shiftKey: boolean = false,
): void => {
  const rawX = round2(toDataX(clientX));
  const rawY = round2(toDataY(clientY));
  if (!pending) {
    pending = { x: rawX, y: rawY };
    pendingDownClient = { x: clientX, y: clientY };
    const el = ensurePreview();
    el.setAttribute("x1", String(rawX));
    el.setAttribute("y1", String(rawY));
    el.setAttribute("x2", String(rawX));
    el.setAttribute("y2", String(rawY));
    return;
  }
  const start = pending;
  const end = resolveLineEnd(start, rawX, rawY, shiftKey);
  pending = null;
  pendingDownClient = null;
  removePreview();
  if (isNegligibleLine(start, end)) {
    // Treat a near-zero-length click as a cancel rather than a 0px line.
    return;
  }
  createLineSegment(start.x, start.y, end.x, end.y, pendingPalette, pendingStyle);
};

// Called from the document-level mouseup / touchend. If the user
// dragged far enough since the down event that set `pending`, commit
// the line at the release point. Otherwise leave `pending` in place —
// they were click-clicking (or tap-tapping), and the next click commits.
export const commitLineOnRelease = (
  clientX: number,
  clientY: number,
  shiftKey: boolean = false,
): void => {
  if (!pending || !pendingDownClient) return;
  if (!isDragRelease(pendingDownClient, clientX, clientY)) return;
  const rawX = round2(toDataX(clientX));
  const rawY = round2(toDataY(clientY));
  const start = pending;
  const end = resolveLineEnd(start, rawX, rawY, shiftKey);
  pending = null;
  pendingDownClient = null;
  removePreview();
  if (isNegligibleLine(start, end)) return;
  createLineSegment(start.x, start.y, end.x, end.y, pendingPalette, pendingStyle);
};

export const updateLinePreview = (
  clientX: number,
  clientY: number,
  shiftKey: boolean = false,
): void => {
  if (!pending || !previewEl) return;
  const rawX = round2(toDataX(clientX));
  const rawY = round2(toDataY(clientY));
  const p = resolveLineEnd(pending, rawX, rawY, shiftKey);
  previewEl.setAttribute("x2", String(p.x));
  previewEl.setAttribute("y2", String(p.y));
};
