// Unit tests for the pure pinch math (brain#24c). These run in
// vitest's node environment — no browser, no touch emulation — which
// is exactly the point: Chromium's touch emulation cannot reproduce
// iOS Safari's visual-viewport zoom, so the arithmetic is what we can
// actually pin down here.

import { describe, expect, it } from "vitest";
import {
  fingerDistance,
  fingerMidpoint,
  pinchAnchor,
  pinchViewport,
  type ViewportLike,
} from "./pinch.ts";
import { MAX_SCALE, MIN_SCALE } from "./viewport.ts";

const V = (x: number, y: number, s: number): ViewportLike => ({ x, y, s });

// Forward transform from viewport.ts: screen = data * s + translate.
const toScreen = (
  v: { x: number; y: number; s: number },
  dx: number,
  dy: number,
): [number, number] => [v.x + dx * v.s, v.y + dy * v.s];

describe("fingerDistance / fingerMidpoint", () => {
  it("measures separation and centre of two touches", () => {
    expect(fingerDistance(0, 0, 3, 4)).toBe(5);
    expect(fingerMidpoint(0, 0, 10, 20)).toEqual({ x: 5, y: 10 });
  });

  it("is order-independent", () => {
    expect(fingerDistance(10, 5, 2, 7)).toBeCloseTo(fingerDistance(2, 7, 10, 5));
    expect(fingerMidpoint(10, 5, 2, 7)).toEqual(fingerMidpoint(2, 7, 10, 5));
  });
});

describe("pinchAnchor", () => {
  it("captures the data point under the finger midpoint", () => {
    // Midpoint (200, 100); viewport translate (50, 20) at scale 2 →
    // data = (200-50)/2, (100-20)/2.
    const a = pinchAnchor(100, 100, 300, 100, V(50, 20, 2));
    expect(a.dataX).toBeCloseTo(75);
    expect(a.dataY).toBeCloseTo(40);
    expect(a.dist).toBeCloseTo(200);
    expect(a.scale).toBe(2);
  });

  it("floors a degenerate separation so the ratio can't explode", () => {
    const a = pinchAnchor(100, 100, 100, 100, V(0, 0, 1));
    expect(a.dist).toBeGreaterThan(0);
    // Spreading to 100px from a degenerate baseline must still land
    // inside the clamp rather than at infinity.
    const next = pinchViewport(a, 50, 100, 150, 100);
    expect(next.s).toBeLessThanOrEqual(MAX_SCALE);
    expect(Number.isFinite(next.x)).toBe(true);
  });

  it("does not mutate the viewport it reads", () => {
    const v = V(50, 20, 2);
    pinchAnchor(0, 0, 10, 10, v);
    expect(v).toEqual({ x: 50, y: 20, s: 2 });
  });
});

describe("pinchViewport — scale from the finger-distance ratio", () => {
  it("doubling the separation doubles the scale", () => {
    const v = V(0, 0, 1);
    const a = pinchAnchor(100, 300, 300, 300, v); // 200px apart
    const next = pinchViewport(a, 0, 300, 400, 300); // 400px apart
    expect(next.s).toBeCloseTo(2);
  });

  it("halving the separation halves the scale", () => {
    const v = V(0, 0, 4);
    const a = pinchAnchor(100, 100, 500, 100, v); // 400px
    const next = pinchViewport(a, 200, 100, 400, 100); // 200px
    expect(next.s).toBeCloseTo(2);
  });

  it("is scale-relative, not absolute — it multiplies the start scale", () => {
    const a = pinchAnchor(0, 0, 100, 0, V(0, 0, 3));
    expect(pinchViewport(a, 0, 0, 150, 0).s).toBeCloseTo(4.5);
  });

  it("holding the separation steady leaves the scale untouched", () => {
    const a = pinchAnchor(100, 100, 300, 100, V(17, 29, 1.375));
    const next = pinchViewport(a, 500, 400, 700, 400);
    expect(next.s).toBeCloseTo(1.375);
  });
});

describe("pinchViewport — zoom around the midpoint", () => {
  it("keeps the data point under the fingers under the fingers", () => {
    const v = V(-120, 60, 1.5);
    const a = pinchAnchor(200, 400, 600, 500, v);
    // Spread the fingers AND slide them: the anchored data point must
    // land exactly on the new midpoint.
    const next = pinchViewport(a, 150, 300, 750, 700);
    const mid = fingerMidpoint(150, 300, 750, 700);
    const [sx, sy] = toScreen(next, a.dataX, a.dataY);
    expect(sx).toBeCloseTo(mid.x, 9);
    expect(sy).toBeCloseTo(mid.y, 9);
  });

  it("a pure two-finger translation pans without zooming", () => {
    const v = V(10, 10, 2);
    const a = pinchAnchor(100, 100, 300, 100, v);
    const next = pinchViewport(a, 140, 175, 340, 175); // +40, +75
    expect(next.s).toBeCloseTo(2);
    expect(next.x).toBeCloseTo(50);
    expect(next.y).toBeCloseTo(85);
  });

  it("zooming in place moves the translate but not the anchor pixel", () => {
    const v = V(0, 0, 1);
    // Fingers centred on (400, 400), spreading symmetrically.
    const a = pinchAnchor(300, 400, 500, 400, v);
    const next = pinchViewport(a, 200, 400, 600, 400);
    expect(next.s).toBeCloseTo(2);
    const [sx, sy] = toScreen(next, a.dataX, a.dataY);
    expect(sx).toBeCloseTo(400);
    expect(sy).toBeCloseTo(400);
  });

  it("round-trips: pinch out then back to the start restores the viewport", () => {
    const v = V(-33, 77, 1.25);
    const a = pinchAnchor(120, 240, 420, 540, v);
    const out = pinchViewport(a, 20, 140, 520, 640);
    expect(out.s).not.toBeCloseTo(v.s);
    const back = pinchViewport(a, 120, 240, 420, 540);
    expect(back.s).toBeCloseTo(v.s);
    expect(back.x).toBeCloseTo(v.x);
    expect(back.y).toBeCloseTo(v.y);
  });
});

describe("pinchViewport — clamping", () => {
  it("never exceeds MAX_SCALE no matter how far the fingers spread", () => {
    const a = pinchAnchor(400, 400, 420, 400, V(0, 0, MAX_SCALE));
    const next = pinchViewport(a, 0, 400, 2000, 400);
    expect(next.s).toBe(MAX_SCALE);
  });

  it("never drops below MIN_SCALE no matter how far the fingers close", () => {
    const a = pinchAnchor(0, 0, 1000, 0, V(0, 0, MIN_SCALE));
    const next = pinchViewport(a, 499, 0, 501, 0);
    expect(next.s).toBe(MIN_SCALE);
  });

  it("uses the same clamp window as the zoom control and the wheel", () => {
    // Deliberately asserted against viewport.ts's exported bounds
    // rather than literals — a drift here is the bug this guards.
    const a = pinchAnchor(0, 0, 100, 0, V(0, 0, 1));
    const zoomedIn = pinchViewport(a, 0, 0, 100 * MAX_SCALE * 4, 0);
    const zoomedOut = pinchViewport(a, 0, 0, 1, 0);
    expect(zoomedIn.s).toBe(MAX_SCALE);
    expect(zoomedOut.s).toBe(MIN_SCALE);
  });

  it("still tracks the midpoint while clamped, so the gesture can pan", () => {
    const a = pinchAnchor(300, 300, 500, 300, V(0, 0, MAX_SCALE));
    // Same separation ⇒ clamped at MAX; fingers slid right by 100px.
    const next = pinchViewport(a, 400, 300, 600, 300);
    expect(next.s).toBe(MAX_SCALE);
    const [sx] = toScreen(next, a.dataX, a.dataY);
    expect(sx).toBeCloseTo(500);
  });
});
