// Floating selection toolbar: appears above the selection bounding
// box whenever 2+ alignable items (boxes and / or texts) are
// selected. Two buttons — align on a horizontal line (match Y
// centers to the selection's mean Y centre) and align on a vertical
// line (match X centers to the mean X centre). Lines, strokes, and
// edges are ignored when computing alignability; they don't have a
// single sensible centre to snap.
//
// The toolbar lives inside #canvas so it inherits the viewport
// translation automatically and pans for free. Positioning uses
// canvas-data coordinates, so the same numbers the boxes use.
//
// updateSelectionToolbar() is fired from applyClasses() in render.ts
// so selection changes immediately reposition / hide the toolbar.

import { mutatedCurrentMap } from "./mutations.ts";

interface BoxLike { id: string; x: number; y: number; }
interface TextLike { id: string; x: number; y: number; }

interface CurrentMap {
  boxes: BoxLike[];
  texts: TextLike[];
}

interface AlignBindings {
  readonly canvas: HTMLElement;
  readonly currentMap: () => CurrentMap;
  readonly selected: Set<string>;
  readonly renderAll: () => void;
}

let bindings: AlignBindings | null = null;
let toolbar: HTMLElement | null = null;

const must = (): AlignBindings => {
  if (!bindings) throw new Error("align: wireAlign() not called");
  return bindings;
};

export const wireAlign = (b: AlignBindings): void => {
  bindings = b;
};

export interface AlignItem {
  ref: { x: number; y: number };
  width: number;
  height: number;
}

const collectAlignable = (): AlignItem[] => {
  const w = must();
  const map = w.currentMap();
  const items: AlignItem[] = [];
  for (const id of w.selected) {
    const b = map.boxes.find((b) => b.id === id);
    if (b) {
      const el = w.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
      if (el) items.push({ ref: b, width: el.offsetWidth, height: el.offsetHeight });
      continue;
    }
    const t = (map.texts ?? []).find((t) => t.id === id);
    if (t) {
      const el = w.canvas.querySelector<HTMLElement>(`.text-item[data-id="${id}"]`);
      if (el) items.push({ ref: t, width: el.offsetWidth, height: el.offsetHeight });
    }
  }
  return items;
};

// Gap inserted between items when an alignment would otherwise leave
// two of them overlapping along the perpendicular axis. Matches the
// 20px background grid so the spread snaps to a familiar rhythm.
export const SPREAD_GAP = 20;

export const anyOverlapAlongX = (items: ReadonlyArray<AlignItem>): boolean => {
  const sorted = [...items].sort((a, b) => a.ref.x - b.ref.x);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.ref.x < prev.ref.x + prev.width) return true;
  }
  return false;
};

export const anyOverlapAlongY = (items: ReadonlyArray<AlignItem>): boolean => {
  const sorted = [...items].sort((a, b) => a.ref.y - b.ref.y);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.ref.y < prev.ref.y + prev.height) return true;
  }
  return false;
};

// Pure alignment math. Mutates each item's ref.x / ref.y in place
// (callers pass live references from the current map). Returns true
// if a meaningful change was attempted (≥2 items), false when the
// selection is too small to align.
//
// Horizontal axis: matches every item's Y centre to the selection's
// mean Y centre, then spreads them along X if any would overlap.
// Vertical axis is the symmetric operation. Spread order keeps the
// item's existing position on the alignment axis primary, with the
// perpendicular axis as a tiebreaker — a vertical stack collapsing
// to a row keeps its top-to-bottom order as left-to-right.
export const alignItems = (
  items: AlignItem[],
  axis: "horizontal" | "vertical",
): boolean => {
  if (items.length < 2) return false;
  if (axis === "horizontal") {
    const meanCy = items.reduce((s, it) => s + it.ref.y + it.height / 2, 0) / items.length;
    for (const it of items) it.ref.y = Math.round(meanCy - it.height / 2);
    if (anyOverlapAlongX(items)) {
      const sorted = [...items].sort(
        (a, b) => (a.ref.x - b.ref.x) || (a.ref.y - b.ref.y),
      );
      let cursor = sorted[0]!.ref.x;
      for (const it of sorted) {
        it.ref.x = Math.round(cursor);
        cursor = it.ref.x + it.width + SPREAD_GAP;
      }
    }
  } else {
    const meanCx = items.reduce((s, it) => s + it.ref.x + it.width / 2, 0) / items.length;
    for (const it of items) it.ref.x = Math.round(meanCx - it.width / 2);
    if (anyOverlapAlongY(items)) {
      const sorted = [...items].sort(
        (a, b) => (a.ref.y - b.ref.y) || (a.ref.x - b.ref.x),
      );
      let cursor = sorted[0]!.ref.y;
      for (const it of sorted) {
        it.ref.y = Math.round(cursor);
        cursor = it.ref.y + it.height + SPREAD_GAP;
      }
    }
  }
  return true;
};

export const applyAlign = (axis: "horizontal" | "vertical"): void => {
  const w = must();
  const items = collectAlignable();
  if (!alignItems(items, axis)) return;
  w.renderAll();
  mutatedCurrentMap();
};

// Build SVG nodes through createElementNS so every element lands in
// the SVG namespace. Setting `<svg>...</svg>` markup via .innerHTML
// on a non-SVG parent gets parsed as HTML — Chromium handles the
// namespace switch but the children can fail to render reliably,
// especially through vite dev's HMR pipeline. Explicit namespace
// construction sidesteps the foreign-content quirks entirely.
const SVG_NS = "http://www.w3.org/2000/svg";

interface RectSpec { x: number; y: number; w: number; h: number; }
interface LineSpec { x1: number; y1: number; x2: number; y2: number; }

const buildIcon = (line: LineSpec, rects: RectSpec[]): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");

  const guide = document.createElementNS(SVG_NS, "line");
  guide.setAttribute("x1", String(line.x1));
  guide.setAttribute("y1", String(line.y1));
  guide.setAttribute("x2", String(line.x2));
  guide.setAttribute("y2", String(line.y2));
  guide.setAttribute("stroke", "currentColor");
  guide.setAttribute("stroke-width", "1");
  guide.setAttribute("stroke-dasharray", "1.5 1.5");
  guide.setAttribute("opacity", "0.55");
  svg.appendChild(guide);

  for (const r of rects) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(r.x));
    rect.setAttribute("y", String(r.y));
    rect.setAttribute("width", String(r.w));
    rect.setAttribute("height", String(r.h));
    rect.setAttribute("fill", "currentColor");
    svg.appendChild(rect);
  }
  return svg;
};

// Illustrator / InDesign-style alignment glyphs: two rectangles
// of differing sizes whose centres both sit on a dashed guide line.
// ICON_H runs the guide line horizontally (what the button does:
// align items onto a horizontal centre line); ICON_V runs it
// vertically. Both icons are 16x16 so the two buttons stay
// visually balanced in the toolbar.
const iconHorizontalAlign = (): SVGSVGElement => buildIcon(
  { x1: 0, y1: 8, x2: 16, y2: 8 },
  [
    { x: 2, y: 3, w: 5, h: 10 },
    { x: 9, y: 5, w: 5, h: 6 },
  ],
);

const iconVerticalAlign = (): SVGSVGElement => buildIcon(
  { x1: 8, y1: 0, x2: 8, y2: 16 },
  [
    { x: 3, y: 2, w: 10, h: 5 },
    { x: 5, y: 9, w: 6,  h: 5 },
  ],
);

export const attachAlignToolbar = (): void => {
  const w = must();
  toolbar = document.createElement("div");
  toolbar.id = "alignToolbar";
  toolbar.style.display = "none";

  const make = (
    icon: SVGSVGElement,
    title: string,
    axis: "horizontal" | "vertical",
  ) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.appendChild(icon);
    btn.title = title;
    btn.setAttribute("aria-label", title);
    // Don't let clicks reach the canvas and clear the selection.
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyAlign(axis);
    });
    return btn;
  };

  toolbar.appendChild(make(iconHorizontalAlign(), "Align on a horizontal line", "horizontal"));
  toolbar.appendChild(make(iconVerticalAlign(),   "Align on a vertical line",   "vertical"));
  w.canvas.appendChild(toolbar);
};

export const updateSelectionToolbar = (): void => {
  if (!toolbar || !bindings) return;
  const items = collectAlignable();
  if (items.length < 2) {
    toolbar.style.display = "none";
    return;
  }
  // renderAll() does `canvas.innerHTML = ""` which strips the
  // toolbar element, so re-attach when needed before positioning.
  if (toolbar.parentNode !== bindings.canvas) {
    bindings.canvas.appendChild(toolbar);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.ref.x);
    minY = Math.min(minY, it.ref.y);
    maxX = Math.max(maxX, it.ref.x + it.width);
  }
  toolbar.style.display = "flex";
  toolbar.style.left = (minX + (maxX - minX) / 2) + "px";
  toolbar.style.top = minY + "px";
};
