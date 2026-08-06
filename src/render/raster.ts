// THROWAWAY SPIKE (brain#25a) — canvas 2D overview layer.
//
// Read-only raster painter for the zoomed-OUT overview, where the DOM
// renderer falls over (docs/canvas-renderer-decision.md §2: the knee
// is ~5,000 simultaneously visible items, and the target is 100,000).
// Nothing here is interactive: at overview zoom every item is a few
// pixels across, so there is nothing to click, hover or edit. That
// constraint is the entire reason this module is ~500 lines instead of
// a renderer rewrite.
//
// Pure: one exported function `(map, view, scale, ctx) => stats`. No
// editor state, no DOM reads, no module state that changes what gets
// painted (the scratch buffers below are allocation reuse only). It
// reuses the existing pure helpers unchanged — graph/shape.ts for
// fixed silhouette sizes, graph/palette.ts for palette/font
// resolution, graph/handle.ts for edge anchors, graph/stroke.ts's
// point model.
//
// Two LOD levels, decided PER ITEM from its on-screen pixel size
// rather than globally from the zoom, because a font-9 box is 3.5x
// taller than a default one and deserves a label at a zoom where the
// default box does not:
//
//   coarse  — filled silhouette only. No border, no label. Every
//             coarse item of the same palette goes into ONE Path2D
//             and is painted with ONE fill(), which is what makes
//             100k items affordable (§3 of the doc: 3.9 ms).
//   fine    — per-item rounded rect + border stroke, and a label if
//             the label would be legible at all.
//
// What it deliberately does NOT do (see §6 "explicitly do not"):
// hit-testing, selection chrome, inline editing, text-metric parity
// with the DOM path, accessibility. Box auto-size is ESTIMATED
// arithmetically (see estimateBoxSize) — the DOM's shrink-to-fit
// layout result is not available to a pure function, and matching it
// exactly is the single biggest risk in productionising this.

import { resolveFont, resolvePalette, type PaletteIndex } from "../graph/palette.ts";
import { fixedShapeSize, SHAPE_CIRCLE, SHAPE_HEX, SHAPE_TRIANGLE } from "../graph/shape.ts";
import { rectAnchor } from "../graph/handle.ts";
import type {
  BoxData,
  ConcreteMap,
  LineData,
  StrokeData,
  TextData,
} from "../graph/serialize.ts";

/** Data-space rectangle currently on screen. */
export interface ViewRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Instrumentation — the spike exists to produce numbers. */
export interface RasterStats {
  /** Items scanned (whole map — the scan is O(map), not O(visible)). */
  scanned: number;
  /** Items that survived the viewport test. */
  visible: number;
  /** Boxes painted in the batched, label-free LOD. */
  coarse: number;
  /** Boxes painted per-item with border. */
  fine: number;
  /** Labels actually rasterised. */
  labels: number;
  lines: number;
  strokes: number;
  edges: number;
  texts: number;
  /** ctx.fill()/stroke()/fillText() calls issued. The headline number:
   *  at full zoom-out this should be ~30, not ~100,000. */
  drawCalls: number;
  /** ms spent scanning boxes: size estimation, viewport test, the
   *  id -> rect index the edge pass needs, and coarse path building. */
  indexMs: number;
  /** ms spent on the stroke/line/edge layers (build + draw). */
  inkMs: number;
  /** ...of which, the line layer. */
  lineMs: number;
  /** ...of which, the edge layer (anchor resolution included). */
  edgeMs: number;
  /** ms spent painting boxes (batched fills + the fine pass). */
  boxMs: number;
  /** ms spent on text items and images. */
  textMs: number;
  /** ms spent in the whole call. */
  totalMs: number;
}

// ── Palette tables ───────────────────────────────────────────────
// Transcribed from src/editor/index.html's `.box.palette-N` /
// `.line-group.palette-N .line-line` / `.stroke-line` / `.edge-line`
// rules. The doc's §7 calls this "one lookup table" and it is: 56 CSS
// rules across 7 element kinds collapse to four arrays.
//
// Palette 9 is the one place canvas cannot mirror CSS: the editor
// paints palette-9 lines white with a doubled drop-shadow to keep
// them legible on the light canvas. A shadowed stroke is a per-item
// draw call, which defeats batching, so the raster path uses black —
// same choice src/render/inline.ts already made for the embed.

interface PaletteColors {
  readonly fill: string;
  readonly border: string;
  readonly text: string;
}

const BOX_COLORS: Readonly<Record<PaletteIndex, PaletteColors>> = {
  1: { fill: "#fff", border: "#333", text: "#333" },
  2: { fill: "#bfdbfe", border: "#1d4ed8", text: "#1e3a8a" },
  3: { fill: "#ddd6fe", border: "#6d28d9", text: "#4c1d95" },
  4: { fill: "#bbf7d0", border: "#15803d", text: "#14532d" },
  5: { fill: "#fef9c3", border: "#a16207", text: "#713f12" },
  6: { fill: "#fecaca", border: "#b91c1c", text: "#7f1d1d" },
  7: { fill: "#fed7aa", border: "#c2410c", text: "#7c2d12" },
  8: { fill: "#e5e7eb", border: "#374151", text: "#111827" },
  9: { fill: "#111", border: "#fff", text: "#fff" },
};

const HUES: Readonly<Record<PaletteIndex, string>> = {
  1: "#333",
  2: "#1d4ed8",
  3: "#6d28d9",
  4: "#15803d",
  5: "#a16207",
  6: "#b91c1c",
  7: "#c2410c",
  8: "#374151",
  9: "#000",
};

const LINE_COLORS: Readonly<Record<PaletteIndex, string>> = {
  ...HUES,
  1: "#555", // .line-line default differs from strokes/edges
};

const TEXT_COLORS: Readonly<Record<PaletteIndex, string>> = {
  ...HUES,
  1: "#222",
  9: "#111",
};

const PALETTES: readonly PaletteIndex[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// ── Metrics ──────────────────────────────────────────────────────
// The `.box.font-N` / `.text-item.font-N` ladder, index 1..9. Index 1
// and 2 are both 16px: 16 is the floor (iOS auto-zooms anything
// smaller on focus) and the ladder is everything above it.
const FONT_PX: readonly number[] = [0, 16, 16, 18, 20, 24, 28, 34, 42, 56];

// .box: padding 0.55em 0.85em, 2px border, line-height 1.2,
// min-width 80px, box-sizing border-box, white-space: pre.
const BOX_PAD_Y_EM = 0.55;
const BOX_PAD_X_EM = 0.85;
const BOX_BORDER = 2;
const BOX_LINE_HEIGHT = 1.2;
const BOX_MIN_W = 80;
const BOX_RADIUS = 6;

// .text-item: padding 4px 6px, line-height 1.3, no border.
const TEXT_PAD_Y = 4;
const TEXT_PAD_X = 6;
const TEXT_LINE_HEIGHT = 1.3;

// Mean advance width of the system sans stack as a fraction of the em,
// over mixed alphanumerics. A guess, and knowingly so — see the module
// header. Validated only against the default single-line box, which
// this reproduces as 41 px tall (the measured value).
const AVG_CHAR_EM = 0.52;

// ── LOD thresholds ───────────────────────────────────────────────
// Both are in SCREEN pixels, so they are zoom-independent statements
// about legibility rather than magic scale numbers.
//
// A label is drawn when its em box would be at least LABEL_MIN_PX
// tall. Below ~6 px, system-ui rasterises to a grey smear that costs
// 3.5x a batched fill (doc §3) and communicates nothing — this is the
// operator's accepted LOD rule, expressed as a threshold.
export const LABEL_MIN_PX = 6;

// A box gets its own rounded rect + border stroke when it would be at
// least DETAIL_MIN_PX tall on screen. Below that the 2px border is
// under a quarter of a pixel and antialiases into the fill, while
// costing 5x a batched fill (doc §3). The doc proposes ~8 px; 8 is
// kept.
export const DETAIL_MIN_PX = 8;

// Minimum on-screen width for any stroked path, in screen px. Without
// this, a 2px line at 1% zoom is 0.02 px and the whole line layer
// disappears — the map would read as disconnected confetti.
const MIN_STROKE_PX = 0.6;

// ── Size estimation ──────────────────────────────────────────────

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly shape?: number | undefined;
}

// Line count + widest line, without allocating. `label.split("\n")`
// costs an array plus a string per box, and at 100k boxes per frame
// that alone was measurable — the scan below replaces it. Results land
// in module scratch because returning an object would put the
// allocation straight back.
let mLines = 1;
let mWidest = 0;
const measureLabel = (label: string): void => {
  let lines = 1;
  let widest = 0;
  let cur = 0;
  for (let i = 0; i < label.length; i++) {
    if (label.charCodeAt(i) === 10) {
      if (cur > widest) widest = cur;
      cur = 0;
      lines++;
    } else {
      cur++;
    }
  }
  mLines = lines;
  mWidest = cur > widest ? cur : widest;
};

/**
 * Footprint of a box in data px.
 *
 * Exact for fixed shapes (graph/shape.ts owns those) and for boxes the
 * user resized (w/h are stored). ESTIMATED for auto-sized rectangles,
 * whose real width and height are a browser layout result that is
 * never persisted — the honest limitation the doc's §7 calls the
 * biggest risk in a production canvas renderer. At overview zoom a box
 * is a few pixels wide, so an estimate that is 10% off is invisible;
 * at readable zoom it would be a visible jump, which is exactly why
 * the DOM path keeps those zooms.
 */
export const estimateBoxSize = (b: BoxData): { w: number; h: number } => {
  const fixed = fixedShapeSize(b.shape);
  if (fixed) return { w: fixed.w, h: fixed.h };
  if (typeof b.w === "number" && typeof b.h === "number") {
    return { w: b.w, h: b.h };
  }
  const f = FONT_PX[resolveFont(b.font)]!;
  measureLabel(b.label);
  const w = Math.max(
    BOX_MIN_W,
    mWidest * f * AVG_CHAR_EM + 2 * BOX_PAD_X_EM * f + 2 * BOX_BORDER,
  );
  const h =
    mLines * f * BOX_LINE_HEIGHT + 2 * BOX_PAD_Y_EM * f + 2 * BOX_BORDER;
  return { w, h };
};

const estimateTextSize = (t: TextData): { w: number; h: number } => {
  const f = FONT_PX[resolveFont(t.font)]!;
  measureLabel(t.label);
  return {
    w: mWidest * f * AVG_CHAR_EM + 2 * TEXT_PAD_X,
    h: mLines * f * TEXT_LINE_HEIGHT + 2 * TEXT_PAD_Y,
  };
};

const overlaps = (
  x: number,
  y: number,
  w: number,
  h: number,
  v: ViewRect,
): boolean => x < v.x2 && x + w > v.x1 && y < v.y2 && y + h > v.y1;

// ── Silhouettes ──────────────────────────────────────────────────
// Added to a shared Path2D so a whole palette's worth of boxes is one
// fill(). Rectangles use plain rect() at coarse LOD: the 6px radius is
// sub-pixel there, and arcs are the expensive part of roundRect.

const addSilhouette = (
  p: Path2D,
  shape: number | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  if (shape === SHAPE_CIRCLE) {
    p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (shape === SHAPE_TRIANGLE) {
    p.moveTo(x + w / 2, y);
    p.lineTo(x + w, y + h);
    p.lineTo(x, y + h);
    p.closePath();
    return;
  }
  if (shape === SHAPE_HEX) {
    // polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)
    p.moveTo(x + w * 0.25, y);
    p.lineTo(x + w * 0.75, y);
    p.lineTo(x + w, y + h / 2);
    p.lineTo(x + w * 0.75, y + h);
    p.lineTo(x + w * 0.25, y + h);
    p.lineTo(x, y + h / 2);
    p.closePath();
    return;
  }
  p.rect(x, y, w, h);
};

const traceFineBox = (
  ctx: CanvasRenderingContext2D,
  shape: number | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): void => {
  ctx.beginPath();
  if (shape === SHAPE_CIRCLE) {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (shape === SHAPE_TRIANGLE) {
    ctx.moveTo(x + w / 2, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
  } else if (shape === SHAPE_HEX) {
    ctx.moveTo(x + w * 0.25, y);
    ctx.lineTo(x + w * 0.75, y);
    ctx.lineTo(x + w, y + h / 2);
    ctx.lineTo(x + w * 0.75, y + h);
    ctx.lineTo(x + w * 0.25, y + h);
    ctx.lineTo(x, y + h / 2);
    ctx.closePath();
  } else {
    ctx.roundRect(x, y, w, h, BOX_RADIUS);
  }
};

// ── Polyline geometry (mirrors render.ts linePathD) ──────────────

const addLinePath = (p: Path2D, l: LineData): void => {
  const mids = l.mids ?? [];
  const style = l.style ?? 1;
  if (style === 2 && mids.length > 0) {
    p.moveTo(l.x1, l.y1);
    for (let i = 0; i < mids.length - 1; i++) {
      const [cx, cy] = mids[i]!;
      const [nx, ny] = mids[i + 1]!;
      p.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
    }
    const last = mids[mids.length - 1]!;
    p.quadraticCurveTo(last[0], last[1], l.x2, l.y2);
    return;
  }
  if (style === 3) {
    const pts: Array<readonly [number, number]> = [
      [l.x1, l.y1],
      ...mids,
      [l.x2, l.y2],
    ];
    p.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
        p.lineTo(bx, ay);
        p.lineTo(bx, by);
      } else {
        p.lineTo(ax, by);
        p.lineTo(bx, by);
      }
    }
    return;
  }
  p.moveTo(l.x1, l.y1);
  for (const [mx, my] of mids) p.lineTo(mx, my);
  p.lineTo(l.x2, l.y2);
};

// Bounding box of a line including its mids — the same conservative
// test culling.ts uses for line styles 2/3 (never cull visible ink).
//
// `pad` is load-bearing, not defensive: a perfectly horizontal or
// vertical line has a ZERO-HEIGHT bounding box, and `overlaps` uses
// strict comparisons, so an unpadded test drops every axis-aligned
// line that happens to sit on a viewport edge. Padding by the rendered
// stroke half-width is also just correct — a line one pixel outside
// the rect still puts ink inside it.
const lineVisible = (l: LineData, v: ViewRect, pad: number): boolean => {
  let minX = Math.min(l.x1, l.x2);
  let maxX = Math.max(l.x1, l.x2);
  let minY = Math.min(l.y1, l.y2);
  let maxY = Math.max(l.y1, l.y2);
  for (const [mx, my] of l.mids ?? []) {
    if (mx < minX) minX = mx;
    if (mx > maxX) maxX = mx;
    if (my < minY) minY = my;
    if (my > maxY) maxY = my;
  }
  return overlaps(
    minX - pad,
    minY - pad,
    maxX - minX + 2 * pad,
    maxY - minY + 2 * pad,
    v,
  );
};

const addStrokePath = (p: Path2D, s: StrokeData): void => {
  const pts = s.points;
  p.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i]![0], pts[i]![1]);
};

const strokeVisible = (s: StrokeData, v: ViewRect, pad: number): boolean => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of s.points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return overlaps(
    minX - pad,
    minY - pad,
    maxX - minX + 2 * pad,
    maxY - minY + 2 * pad,
    v,
  );
};

// ── Scratch buffers ──────────────────────────────────────────────
// Allocation reuse only: nothing here influences what gets painted,
// it just stops a 100k-item frame from handing the GC 3 MB of
// short-lived objects 60 times a second. Grown, never shrunk.

// Per-box footprint, parallel to `map.boxes`. One object per box per
// frame was 100,000 allocations at the target scale; typed arrays make
// the scan allocation-free.
let boxW: Float64Array = new Float64Array(0);
let boxH: Float64Array = new Float64Array(0);
// Indices of the boxes that earned the fine LOD.
let fineIdx: Int32Array = new Int32Array(0);

const ensureBoxCap = (n: number): void => {
  if (boxW.length >= n) return;
  const cap = Math.max(64, 1 << (32 - Math.clz32(n - 1)));
  boxW = new Float64Array(cap);
  boxH = new Float64Array(cap);
  fineIdx = new Int32Array(cap);
};

const emptyStats = (): RasterStats => ({
  scanned: 0,
  visible: 0,
  coarse: 0,
  fine: 0,
  labels: 0,
  lines: 0,
  strokes: 0,
  edges: 0,
  texts: 0,
  drawCalls: 0,
  indexMs: 0,
  inkMs: 0,
  lineMs: 0,
  edgeMs: 0,
  boxMs: 0,
  textMs: 0,
  totalMs: 0,
});

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Paint `map` into `ctx`.
 *
 * `view` is the data-space rectangle currently on screen and `scale`
 * the data-px -> css-px factor — i.e. exactly what viewport.ts already
 * computes for the DOM transform, so the two renderers cannot drift.
 *
 * The caller owns clearing and any devicePixelRatio transform; this
 * function composes the data->screen transform on top of whatever is
 * already set and restores it before returning.
 */
export const drawMap = (
  map: ConcreteMap,
  view: ViewRect,
  scale: number,
  ctx: CanvasRenderingContext2D,
): RasterStats => {
  const t0 = now();
  const stats = emptyStats();
  const boxes = map.boxes ?? [];

  ctx.save();
  ctx.transform(scale, 0, 0, scale, -view.x1 * scale, -view.y1 * scale);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const dataPx = (screenPx: number): number => screenPx / scale;
  const strokeWidth = (cssPx: number): number =>
    Math.max(cssPx, dataPx(MIN_STROKE_PX));

  // ── Pass 1: scan boxes, classify LOD, build the edge index ─────
  // O(map), not O(visible): every box must be tested, and every box
  // may be an edge endpoint whether or not it is on screen. That is
  // the same O(map) cost the doc flags as row 5 for the DOM path, and
  // the raster path does NOT escape it.
  const tIndex = now();
  const edges = map.edges ?? [];
  // The id -> box index is only needed to resolve edge endpoints. Maps
  // with no edges skip it entirely, which is worth a branch: at 100k
  // boxes the Map build alone is ~13 ms of a 50 ms budget.
  const byId = edges.length > 0 ? new Map<string, number>() : null;
  const coarse = new Map<PaletteIndex, Path2D>();
  ensureBoxCap(boxes.length);
  let nFine = 0;

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const { w, h } = estimateBoxSize(b);
    boxW[i] = w;
    boxH[i] = h;
    if (byId) byId.set(b.id, i);
    stats.scanned++;
    if (!overlaps(b.x, b.y, w, h, view)) continue;
    stats.visible++;
    if (h * scale < DETAIL_MIN_PX) {
      const pal = resolvePalette(b.palette);
      let p = coarse.get(pal);
      if (!p) {
        p = new Path2D();
        coarse.set(pal, p);
      }
      addSilhouette(p, b.shape, b.x, b.y, w, h);
      stats.coarse++;
    } else {
      fineIdx[nFine] = i;
      nFine++;
      stats.fine++;
    }
  }
  stats.indexMs = now() - tIndex;
  const tInk = now();

  // ── Pass 2: ink below the boxes — strokes, lines, edges ────────
  // One Path2D per palette per layer, one stroke() each: 27 draw
  // calls for the entire line/stroke/edge population, against the
  // 332,678 SVG nodes the DOM path builds for the same picture.
  const strokePaths = new Map<PaletteIndex, Path2D>();
  for (const s of map.strokes ?? []) {
    if (!s.points || s.points.length < 2) continue;
    stats.scanned++;
    if (!strokeVisible(s, view, strokeWidth(3) / 2)) continue;
    stats.visible++;
    stats.strokes++;
    const pal = resolvePalette(s.palette);
    let p = strokePaths.get(pal);
    if (!p) {
      p = new Path2D();
      strokePaths.set(pal, p);
    }
    addStrokePath(p, s);
  }
  ctx.lineWidth = strokeWidth(3);
  for (const pal of PALETTES) {
    const p = strokePaths.get(pal);
    if (!p) continue;
    ctx.strokeStyle = HUES[pal];
    ctx.stroke(p);
    stats.drawCalls++;
  }

  const tLine = now();
  const linePaths = new Map<PaletteIndex, Path2D>();
  for (const l of map.lines ?? []) {
    stats.scanned++;
    if (!lineVisible(l, view, strokeWidth(2) / 2)) continue;
    stats.visible++;
    stats.lines++;
    const pal = resolvePalette(l.palette);
    let p = linePaths.get(pal);
    if (!p) {
      p = new Path2D();
      linePaths.set(pal, p);
    }
    addLinePath(p, l);
  }
  ctx.lineWidth = strokeWidth(2);
  for (const pal of PALETTES) {
    const p = linePaths.get(pal);
    if (!p) continue;
    ctx.strokeStyle = LINE_COLORS[pal];
    ctx.stroke(p);
    stats.drawCalls++;
  }

  stats.lineMs = now() - tLine;

  const tEdge = now();
  const edgePaths = new Map<PaletteIndex, Path2D>();
  for (const e of edges) {
    stats.scanned++;
    const ia = byId!.get(e.from);
    const ib = byId!.get(e.to);
    if (ia === undefined || ib === undefined) continue;
    const a = boxes[ia]!;
    const b = boxes[ib]!;
    const aw = boxW[ia]!;
    const ah = boxH[ia]!;
    const bw = boxW[ib]!;
    const bh = boxH[ib]!;
    const acx = a.x + aw / 2;
    const acy = a.y + ah / 2;
    const bcx = b.x + bw / 2;
    const bcy = b.y + bh / 2;
    let ax: number;
    let ay: number;
    let bx: number;
    let by: number;
    // LOD, third instance. rectAnchor -> nearestHandle evaluates all
    // EIGHT handle positions and picks the closest — ~9 Vec2
    // allocations per endpoint, i.e. 360,000 arrays per frame at
    // 20,000 edges. When the boxes are a few pixels tall, which of the
    // 8 anchors an edge lands on is sub-pixel information. Centre to
    // centre instead, and let the box fill cover the stub.
    if (ah * scale < DETAIL_MIN_PX && bh * scale < DETAIL_MIN_PX) {
      ax = acx;
      ay = acy;
      bx = bcx;
      by = bcy;
    } else {
      const fromBox = { x: a.x, y: a.y, width: aw, height: ah };
      const toBox = { x: b.x, y: b.y, width: bw, height: bh };
      const from = rectAnchor(fromBox, e.fromHandle, [bcx, bcy], a.shape);
      const to = rectAnchor(toBox, e.toHandle, [acx, acy], b.shape);
      ax = from[0];
      ay = from[1];
      bx = to[0];
      by = to[1];
    }
    const epad = strokeWidth(2) / 2;
    if (
      !overlaps(
        Math.min(ax, bx) - epad,
        Math.min(ay, by) - epad,
        Math.abs(bx - ax) + 2 * epad,
        Math.abs(by - ay) + 2 * epad,
        view,
      )
    ) {
      continue;
    }
    stats.visible++;
    stats.edges++;
    const pal = resolvePalette(e.palette);
    let p = edgePaths.get(pal);
    if (!p) {
      p = new Path2D();
      edgePaths.set(pal, p);
    }
    p.moveTo(ax, ay);
    p.lineTo(bx, by);
  }
  ctx.lineWidth = strokeWidth(2);
  for (const pal of PALETTES) {
    const p = edgePaths.get(pal);
    if (!p) continue;
    ctx.strokeStyle = HUES[pal];
    ctx.stroke(p);
    stats.drawCalls++;
  }
  // Arrowheads are deliberately dropped: a marker is a per-edge path,
  // and at overview zoom a 6px marker is sub-pixel anyway.
  stats.edgeMs = now() - tEdge;
  stats.inkMs = now() - tInk;

  // ── Pass 3: boxes ──────────────────────────────────────────────
  const tBox = now();
  for (const pal of PALETTES) {
    const p = coarse.get(pal);
    if (!p) continue;
    ctx.fillStyle = BOX_COLORS[pal].fill;
    ctx.fill(p);
    stats.drawCalls++;
    // Coarse items get no border. On a #fafafa canvas a white
    // palette-1 box would then be nearly invisible, so palette 1 is
    // the one coarse kind that is outlined — as a SECOND batched
    // stroke of the same path, still one draw call for all of them.
    if (pal === 1) {
      ctx.lineWidth = strokeWidth(1);
      ctx.strokeStyle = BOX_COLORS[1].border;
      ctx.stroke(p);
      stats.drawCalls++;
    }
  }

  ctx.lineWidth = strokeWidth(BOX_BORDER);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < nFine; i++) {
    const bi = fineIdx[i]!;
    const b = boxes[bi]!;
    const pal = resolvePalette(b.palette);
    const colors = BOX_COLORS[pal];
    const x = b.x;
    const y = b.y;
    const w = boxW[bi]!;
    const h = boxH[bi]!;
    traceFineBox(ctx, b.shape, x, y, w, h);
    ctx.fillStyle = colors.fill;
    ctx.fill();
    ctx.strokeStyle = colors.border;
    ctx.stroke();
    stats.drawCalls += 2;
    const f = FONT_PX[resolveFont(b.font)]!;
    if (f * scale >= LABEL_MIN_PX && b.label.length > 0) {
      ctx.fillStyle = colors.text;
      ctx.font = `${f}px system-ui, -apple-system, sans-serif`;
      // First line only. Wrapping, clamping and ellipsis are a
      // measureText loop per box — the exact cost the LOD exists to
      // avoid, and out of scope per §6.
      const first = b.label.indexOf("\n");
      const text = first < 0 ? b.label : b.label.slice(0, first);
      ctx.fillText(text, x + w / 2, y + h / 2);
      stats.drawCalls++;
      stats.labels++;
    }
  }

  stats.boxMs = now() - tBox;

  // ── Pass 4: text items ─────────────────────────────────────────
  // Same coarse/fine split as boxes. Sub-legible text still has to
  // leave ink — otherwise the overview silently loses every annotation
  // on the map — but that ink is batched into one Path2D per palette,
  // not a fillRect per item. That single change took the whole-map
  // frame from 5,013 draw calls to 22.
  const tText = now();
  const textInk = new Map<PaletteIndex, Path2D>();
  for (const t of map.texts ?? []) {
    stats.scanned++;
    const { w, h } = estimateTextSize(t);
    if (!overlaps(t.x, t.y, w, h, view)) continue;
    stats.visible++;
    stats.texts++;
    const pal = resolvePalette(t.palette);
    const f = FONT_PX[resolveFont(t.font)]!;
    if (f * scale >= LABEL_MIN_PX) {
      ctx.fillStyle = TEXT_COLORS[pal];
      ctx.font = `${f}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const first = t.label.indexOf("\n");
      ctx.fillText(
        first < 0 ? t.label : t.label.slice(0, first),
        t.x + TEXT_PAD_X,
        t.y + TEXT_PAD_Y,
      );
      stats.drawCalls++;
      stats.labels++;
    } else {
      let p = textInk.get(pal);
      if (!p) {
        p = new Path2D();
        textInk.set(pal, p);
      }
      p.rect(t.x + TEXT_PAD_X, t.y + h / 2 - f * 0.3, w - 2 * TEXT_PAD_X, f * 0.6);
    }
  }
  if (textInk.size > 0) {
    ctx.globalAlpha = 0.45;
    for (const pal of PALETTES) {
      const p = textInk.get(pal);
      if (!p) continue;
      ctx.fillStyle = TEXT_COLORS[pal];
      ctx.fill(p);
      stats.drawCalls++;
    }
    ctx.globalAlpha = 1;
  }

  // ── Pass 5: images ─────────────────────────────────────────────
  // Placeholder frames only. Decoding bitmaps is asynchronous and a
  // pure function cannot own an image cache; a real version needs one.
  const images = map.images ?? [];
  if (images.length > 0) {
    ctx.fillStyle = "#e5e7eb";
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = strokeWidth(1);
    for (const img of images) {
      stats.scanned++;
      if (!overlaps(img.x, img.y, img.width, img.height, view)) continue;
      stats.visible++;
      ctx.fillRect(img.x, img.y, img.width, img.height);
      ctx.strokeRect(img.x, img.y, img.width, img.height);
      stats.drawCalls += 2;
    }
  }

  stats.textMs = now() - tText;

  ctx.restore();
  stats.totalMs = now() - t0;
  return stats;
};
