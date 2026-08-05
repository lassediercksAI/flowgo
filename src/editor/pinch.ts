// Pure two-finger pinch math, extracted from touch.ts so it can be
// unit-tested without a browser (vitest runs env:node — this module
// must never touch `window` or `document` at import time).
//
// The model mirrors what every canvas tool does: a pinch is ONE
// gesture that carries both a scale and a translation. We snapshot the
// data-space point under the finger midpoint when the gesture starts,
// then on every move solve for the viewport translate that keeps that
// same data point under the CURRENT midpoint at the new scale. Falling
// out of that for free: two fingers moved without changing their
// separation pan the canvas, which is what people expect and what the
// old browser-delegated pinch used to give us.
//
// Coordinates: `client` = CSS pixels from the touch events, `data` =
// canvas/model units. The transform convention is the one documented
// in viewport.ts: screen = data * s + translate.

import { clampScale } from "./viewport.ts";

export interface ViewportLike {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}

// Everything the move handler needs to resolve a pinch, captured once
// when the second finger lands (and re-captured whenever the number of
// fingers changes, so adding/removing a finger doesn't teleport the
// canvas).
export interface PinchAnchor {
  /** Finger separation in client px at capture time. Always > 0. */
  readonly dist: number;
  /** Data-space point under the finger midpoint at capture time. */
  readonly dataX: number;
  readonly dataY: number;
  /** viewport.s at capture time — the base the ratio multiplies. */
  readonly scale: number;
}

// Guard for degenerate baselines: two fingers reported at (nearly) the
// same point would make the distance ratio explode. 1px is far below
// any real two-finger placement (fingers are ~40px apart at minimum)
// and above the float noise of coalesced touch coordinates.
const MIN_DIST = 1;

export const fingerDistance = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => Math.hypot(bx - ax, by - ay);

export const fingerMidpoint = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { readonly x: number; readonly y: number } => ({
  x: (ax + bx) / 2,
  y: (ay + by) / 2,
});

// Capture the gesture baseline. `v` is read, never mutated.
export const pinchAnchor = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  v: ViewportLike,
): PinchAnchor => {
  const mid = fingerMidpoint(ax, ay, bx, by);
  return {
    dist: Math.max(MIN_DIST, fingerDistance(ax, ay, bx, by)),
    dataX: (mid.x - v.x) / v.s,
    dataY: (mid.y - v.y) / v.s,
    scale: v.s,
  };
};

// Resolve the viewport for the current finger positions. Returns the
// full {x, y, s} triple so the caller does one atomic write followed by
// one applyViewport() — no intermediate state ever reaches the DOM.
//
// Clamping uses viewport.ts's clampScale so pinch, the wheel, and the
// bottom-left zoom control can never disagree about MIN/MAX_SCALE. Note
// that a clamped scale still tracks the midpoint: at 800% you can keep
// pinching to drag the canvas around rather than having the gesture go
// dead under your fingers.
export const pinchViewport = (
  anchor: PinchAnchor,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { readonly x: number; readonly y: number; readonly s: number } => {
  const dist = Math.max(MIN_DIST, fingerDistance(ax, ay, bx, by));
  const mid = fingerMidpoint(ax, ay, bx, by);
  const s = clampScale(anchor.scale * (dist / anchor.dist));
  return {
    x: mid.x - anchor.dataX * s,
    y: mid.y - anchor.dataY * s,
    s,
  };
};
