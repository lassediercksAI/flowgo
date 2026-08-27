// Regression test for the hex/triangle border-disappears-at-zoom bug
// (PR#114, shipped v0.3.18).
//
// The fill pseudo-element used to be inset from the border pseudo-
// element with a plain `inset: Npx` on the BOUNDING BOX. That is wrong
// for any polygon edge that isn't axis-aligned: insetting a bounding
// box by d moves a slanted edge inward by d·sin(θ) perpendicular, not
// d. On the triangle that measured 6 device px of border ink on the
// flat bottom edge against 2-3px on the diagonals at dpr 2 — thin
// enough to round away to nothing once the canvas was scaled down.
//
// The fix replaced the inset box with an explicit inner polygon
// (`--hex-poly-inner` / `--tri-poly-inner` in the editor, the matching
// literal `clip-path: polygon(...)` on `.fgi-box.fgi-hex/tri::after`
// in the inline read-only renderer) that is the OUTER polygon scaled
// about its incentre, so every edge — flat or diagonal — sits the
// same perpendicular distance inside its outer twin.
//
// This file pins that geometric invariant directly against the source
// text of both copies of the constants, so a future "simplify this
// back to an inset box" edit fails CI instead of shipping quietly to
// all six surfaces (editor, gallery, Obsidian, VS Code, remark,
// browser extension) at once. `grep poly-inner` previously found zero
// test references — this is that missing pin.
//
// Deliberately does NOT touch box colour/fill: the palette-colours-
// never-apply-in-the-inline-renderer bug is real but separate
// (out of scope here) and asserting on colour would risk locking in
// that broken behaviour as "correct".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEX_H, HEX_W } from "../graph/hex.ts";
import { TRI_H, TRI_W } from "../graph/shape.ts";

interface Pt {
  readonly x: number;
  readonly y: number;
}

// "25.48% 0.97%, 74.52% 0.97%, ..." -> fractional (0..1) points.
const parsePolygon = (polygonCss: string): Pt[] => {
  const m = polygonCss.match(/polygon\(([^)]*)\)/);
  if (!m) throw new Error(`no polygon(...) found in: ${polygonCss}`);
  return m[1]!.split(",").map((pair) => {
    const parts = pair.trim().split(/\s+/);
    const xs = parts[0]!;
    const ys = parts[1]!;
    if (!xs.endsWith("%") || !ys.endsWith("%")) {
      throw new Error(`expected percentage pair, got: ${pair}`);
    }
    return { x: parseFloat(xs) / 100, y: parseFloat(ys) / 100 };
  });
};

const toPx = (p: Pt, w: number, h: number): Pt => ({ x: p.x * w, y: p.y * h });

// Perpendicular distance from point p to the infinite line through a,b.
const distPointToLine = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) throw new Error("degenerate edge (a === b)");
  return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
};

// For each edge i of `outer` (vertex i -> vertex i+1), measure the
// perpendicular distance from the corresponding inner edge's midpoint
// to the outer edge's line. Vertex order must correspond 1:1 between
// outer and inner (true here: --*-poly-inner is --*-poly scaled about
// a fixed centre, which preserves vertex order and edge parallelism).
const edgeInsets = (
  outer: readonly Pt[],
  inner: readonly Pt[],
  w: number,
  h: number,
): number[] => {
  const n = outer.length;
  expect(inner.length, "inner/outer vertex count must match").toBe(n);
  const outerPx = outer.map((p) => toPx(p, w, h));
  const innerPx = inner.map((p) => toPx(p, w, h));
  const insets: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = outerPx[i]!;
    const b = outerPx[(i + 1) % n]!;
    const ia = innerPx[i]!;
    const ib = innerPx[(i + 1) % n]!;
    const mid = { x: (ia.x + ib.x) / 2, y: (ia.y + ib.y) / 2 };
    insets.push(distPointToLine(mid, a, b));
  }
  return insets;
};

// Assert every edge is inset by the same perpendicular distance
// (within `epsilonPx` of rounding slop from the 2-decimal percentages
// in source), AND that the distance is a real, non-trivial inset
// (catches a regression that sets poly-inner = poly, which would
// still be "uniform" at zero).
const assertUniformInset = (
  insets: readonly number[],
  expectedPx: number,
  epsilonPx = 0.15,
): void => {
  const min = Math.min(...insets);
  const max = Math.max(...insets);
  expect(
    max - min,
    `border inset varies by edge (min ${min.toFixed(3)}px, max ${max.toFixed(3)}px) — ` +
      `this is exactly the bounding-box-inset bug (PR#114): a slanted edge is inset by ` +
      `d·sin(θ) instead of d while an axis-aligned edge gets the full d`,
  ).toBeLessThanOrEqual(epsilonPx);
  for (const d of insets) {
    expect(d, "border inset must be a real non-zero perpendicular offset").toBeCloseTo(
      expectedPx,
      0,
    );
  }
};

const EDITOR_HTML_PATH = join(process.cwd(), "src/editor/index.html");
const INLINE_TS_PATH = join(process.cwd(), "src/render/inline.ts");

describe("hex/triangle border inset: editor copy (src/editor/index.html)", () => {
  const html = readFileSync(EDITOR_HTML_PATH, "utf8");

  const extractVar = (name: string): string => {
    // e.g. `--hex-poly-inner: polygon(...);` — colon anchors the name
    // so `--hex-poly:` doesn't also match `--hex-poly-inner:`.
    const re = new RegExp(`${name}:\\s*(polygon\\([^;]*\\));`);
    const m = html.match(re);
    expect(m, `expected to find CSS custom property ${name} in index.html`).not.toBeNull();
    return m![1]!;
  };

  it("hex: every edge of --hex-poly-inner is inset ~2px from --hex-poly", () => {
    const outer = parsePolygon(extractVar("--hex-poly"));
    const inner = parsePolygon(extractVar("--hex-poly-inner"));
    expect(outer.length).toBe(6);
    const insets = edgeInsets(outer, inner, HEX_W, HEX_H);
    assertUniformInset(insets, 2);
  });

  it("triangle: every edge of --tri-poly-inner is inset ~3px from --tri-poly", () => {
    const outer = parsePolygon(extractVar("--tri-poly"));
    const inner = parsePolygon(extractVar("--tri-poly-inner"));
    expect(outer.length).toBe(3);
    const insets = edgeInsets(outer, inner, TRI_W, TRI_H);
    assertUniformInset(insets, 3);
  });
});

describe("hex/triangle border inset: inline read-only renderer copy (src/render/inline.ts)", () => {
  const ts = readFileSync(INLINE_TS_PATH, "utf8");

  // The inline renderer has no CSS custom properties (STYLE_CSS is a
  // flat string injected as a <style> tag) — the outer/inner polygons
  // are literal clip-path values on the ::before/::after rules.
  const extractClipPath = (selector: string): string => {
    const re = new RegExp(
      `${selector.replace(/[.:]/g, "\\$&")}\\s*\\{[^}]*clip-path:\\s*(polygon\\([^;]*?\\))`,
    );
    const m = ts.match(re);
    expect(m, `expected to find clip-path on ${selector} in inline.ts`).not.toBeNull();
    return m![1]!;
  };

  it("hex: ::after (fill) is inset ~2px from ::before (border) on every edge", () => {
    const outer = parsePolygon(extractClipPath(".fgi-box.fgi-hex::before"));
    const inner = parsePolygon(extractClipPath(".fgi-box.fgi-hex::after"));
    expect(outer.length).toBe(6);
    const insets = edgeInsets(outer, inner, HEX_W, HEX_H);
    assertUniformInset(insets, 2);
  });

  it("triangle: ::after (fill) is inset ~3px from ::before (border) on every edge", () => {
    const outer = parsePolygon(extractClipPath(".fgi-box.fgi-tri::before"));
    const inner = parsePolygon(extractClipPath(".fgi-box.fgi-tri::after"));
    expect(outer.length).toBe(3);
    const insets = edgeInsets(outer, inner, TRI_W, TRI_H);
    assertUniformInset(insets, 3);
  });

  it("hex/triangle inner polygons in the editor and inline renderer are byte-identical", () => {
    // Both copies must move together, or one of the six embedding
    // surfaces silently regresses while the others stay fixed.
    const html = readFileSync(EDITOR_HTML_PATH, "utf8");
    const editorHexInner = html.match(/--hex-poly-inner:\s*(polygon\([^;]*\));/)![1]!;
    const editorTriInner = html.match(/--tri-poly-inner:\s*(polygon\([^;]*\));/)![1]!;
    const inlineHexInner = extractClipPath(".fgi-box.fgi-hex::after");
    const inlineTriInner = extractClipPath(".fgi-box.fgi-tri::after");
    expect(inlineHexInner).toBe(editorHexInner.replace(/;$/, ""));
    expect(inlineTriInner).toBe(editorTriInner.replace(/;$/, ""));
  });
});
