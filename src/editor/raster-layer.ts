// THROWAWAY SPIKE (brain#25a) — the ~120 lines of glue that let the
// pure painter in ../render/raster.ts stand in for the DOM renderer
// at overview zoom.
//
// Off unless the URL carries `?raster=1`. When on:
//   • MIN_SCALE drops to RASTER_MIN_SCALE so the user can actually
//     zoom out far enough to need this (viewport.ts ships 0.5, which
//     is precisely what makes the DOM path fine today);
//   • below TAKEOVER_SCALE the canvas paints and the DOM renderer is
//     told its viewport is empty, so updateCulling drops every
//     element it holds;
//   • at or above TAKEOVER_SCALE the canvas is hidden and the DOM
//     path runs exactly as it does on main.
//
// Nothing here touches attach/mouse/touch/movers/edit. The canvas is
// `pointer-events: none` and no interaction is implemented on it —
// see the module header of raster.ts for why that is the point.

import { drawMap, estimateBoxSize, type RasterStats, type ViewRect } from "../render/raster.ts";
import type { ConcreteMap } from "../graph/serialize.ts";
import { applyViewport, setMinScale, viewport } from "./viewport.ts";

// Below this scale the raster layer owns the picture. 0.5 is today's
// MIN_SCALE, i.e. the takeover point is exactly the zoom the DOM
// renderer currently refuses to go past — no behaviour changes at any
// zoom the product permits today.
export const TAKEOVER_SCALE = 0.5;

// How far out the spike lets you go. 0.01 is the value the decision
// doc's §2 measurements used.
export const RASTER_MIN_SCALE = 0.01;

export interface RasterBindings {
  readonly currentMap: () => ConcreteMap;
  /** Called after every paint — the perf harness reads this. */
  readonly onStats?: (s: RasterStats | null) => void;
}

let bindings: RasterBindings | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let frame: number | null = null;
let enabled = false;
// "dom" unlocks the same zoom range but never paints — it exists so the
// A/B between the two renderers runs on ONE build, rather than
// comparing this branch against the throwaway MIN_SCALE build the
// decision doc's §2 table used.
let mode: "off" | "on" | "dom" = "off";

export const rasterEnabled = (): boolean => enabled;

/** True while the raster layer, not the DOM, owns the picture. */
export const rasterActive = (): boolean =>
  mode === "on" && enabled && viewport.s < TAKEOVER_SCALE;

const readMode = (): "off" | "on" | "dom" => {
  try {
    const v = new URLSearchParams(window.location.search).get("raster");
    if (v === "1") return "on";
    if (v === "dom") return "dom";
    return "off";
  } catch {
    return "off";
  }
};

const sizeCanvas = (): void => {
  if (!canvasEl) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
  }
};

const paint = (): void => {
  frame = null;
  if (!canvasEl || !ctx || !bindings) return;
  if (!rasterActive()) {
    if (canvasEl.style.display !== "none") {
      canvasEl.style.display = "none";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    }
    bindings.onStats?.(null);
    return;
  }
  canvasEl.style.display = "block";
  sizeCanvas();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const s = viewport.s;
  const view: ViewRect = {
    x1: -viewport.x / s,
    y1: -viewport.y / s,
    x2: (window.innerWidth - viewport.x) / s,
    y2: (window.innerHeight - viewport.y) / s,
  };
  const stats = drawMap(bindings.currentMap(), view, s, ctx);
  bindings.onStats?.(stats);
};

/** rAF-coalesced repaint request. Wired to viewport.ts's cull hook, so
 *  it fires on exactly the same signal the DOM renderer re-culls on. */
export const scheduleRasterPaint = (): void => {
  if (!enabled || frame !== null) return;
  frame = requestAnimationFrame(paint);
};

/** Park the camera so the whole map fits the window, with a small
 *  margin. Measurement affordance: `recenter()` centres on box b0, so
 *  ~3/4 of the viewport is empty and "fully zoomed out" does not mean
 *  "whole map on screen" (the trap §8 of the doc warns about). */
const fitAll = (): { scale: number; items: number } => {
  const map = bindings?.currentMap();
  if (!map) return { scale: viewport.s, items: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number, w = 0, h = 0): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  };
  for (const b of map.boxes ?? []) {
    const { w, h } = estimateBoxSize(b);
    grow(b.x, b.y, w, h);
  }
  for (const t of map.texts ?? []) grow(t.x, t.y);
  for (const l of map.lines ?? []) {
    grow(l.x1, l.y1);
    grow(l.x2, l.y2);
  }
  if (!Number.isFinite(minX)) return { scale: viewport.s, items: 0 };
  const s = Math.min(
    (window.innerWidth * 0.96) / (maxX - minX),
    (window.innerHeight * 0.96) / (maxY - minY),
  );
  viewport.s = Math.max(RASTER_MIN_SCALE, s);
  viewport.x = window.innerWidth / 2 - ((minX + maxX) / 2) * viewport.s;
  viewport.y = window.innerHeight / 2 - ((minY + maxY) / 2) * viewport.s;
  applyViewport();
  return {
    scale: viewport.s,
    items:
      (map.boxes?.length ?? 0) +
      (map.lines?.length ?? 0) +
      (map.strokes?.length ?? 0) +
      (map.edges?.length ?? 0) +
      (map.texts?.length ?? 0),
  };
};

export const wireRaster = (b: RasterBindings): void => {
  bindings = b;
  mode = readMode();
  if (mode === "off") return;
  setMinScale(RASTER_MIN_SCALE);
  enabled = true;
  canvasEl = document.getElementById("raster") as HTMLCanvasElement | null;
  ctx = canvasEl ? canvasEl.getContext("2d", { alpha: true }) : null;
  if (!canvasEl || !ctx) {
    enabled = false;
    mode = "dom";
  }
  if (enabled) {
    sizeCanvas();
    window.addEventListener("resize", scheduleRasterPaint);
  }
  // Measurement + eyeballing handle. Spike-only.
  (window as unknown as Record<string, unknown>)["__flowgoRaster"] = {
    mode: () => mode,
    active: rasterActive,
    repaint: scheduleRasterPaint,
    fitAll,
    stats: () => lastStats,
    worst: () => worstStats,
    reset: () => {
      worstStats = null;
      paints = 0;
    },
    paints: () => paints,
  };
  scheduleRasterPaint();
};

let lastStats: RasterStats | null = null;
let worstStats: RasterStats | null = null;
let paints = 0;
export const recordStats = (s: RasterStats | null): void => {
  lastStats = s;
  if (!s) return;
  paints++;
  if (!worstStats || s.totalMs > worstStats.totalMs) worstStats = s;
};
