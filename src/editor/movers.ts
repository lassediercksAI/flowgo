// Drag movers: factories that produce { el, apply(dx, dy, ev) } for
// each kind of draggable item. The mover stores its starting position
// at construction so the drag handler can compute new positions from a
// pointer delta and apply them to both the data object and the DOM.
//
// Shift-snap is shared via the GRID + snap helpers; it lives here
// because all movers need it and nothing else in the editor cares.

import type { HandleCode } from "../graph/handle.ts";
import { HEX_H, HEX_W, snapHexCenter, snapHexGroup } from "../graph/hex.ts";
import { strokePathD } from "../graph/stroke.ts";
import { updateSizedLabelClamp } from "./label-clamp.ts";

export const GRID = 20;
export const snap = (v: number): number => Math.round(v / GRID) * GRID;

export interface BoxLike {
  x: number;
  y: number;
  // Explicit size (resize feature). Absent = auto-size to the label.
  // Never set on hexagons (shape = 1) — they keep the fixed lattice size.
  w?: number;
  h?: number;
  // Render silhouette: 0/unset rectangle, 1 hexagon. See graph/hex.ts.
  shape?: number;
}

export interface TextLike {
  x: number;
  y: number;
}

export interface LineLike {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
  style?: number;
}

// Mirrors render.ts linePathD — kept here so the movers can rewrite
// the live SVG path without round-tripping through the renderer.
const linePathD = (l: LineLike): string => {
  const mids = l.mids ?? [];
  const points: Array<[number, number]> = [
    [l.x1, l.y1],
    ...mids,
    [l.x2, l.y2],
  ];
  const style = l.style ?? 1;

  if (style === 2 && mids.length > 0) {
    let d = `M ${l.x1} ${l.y1}`;
    for (let i = 0; i < mids.length - 1; i++) {
      const [cx, cy] = mids[i]!;
      const [nx, ny] = mids[i + 1]!;
      d += ` Q ${cx} ${cy} ${(cx + nx) / 2} ${(cy + ny) / 2}`;
    }
    const last = mids[mids.length - 1]!;
    d += ` Q ${last[0]} ${last[1]} ${l.x2} ${l.y2}`;
    return d;
  }

  if (style === 3) {
    let d = `M ${points[0]![0]} ${points[0]![1]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
        d += ` L ${bx} ${ay} L ${bx} ${by}`;
      } else {
        d += ` L ${ax} ${by} L ${bx} ${by}`;
      }
    }
    return d;
  }

  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i]![0]} ${points[i]![1]}`;
  }
  return d;
};

export interface Mover {
  readonly el: Element;
  apply(dx: number, dy: number, ev: { shiftKey?: boolean } | null): void;
}

export const makeBoxMover = (b: BoxLike, el: HTMLElement): Mover => {
  const startX = b.x;
  const startY = b.y;
  return {
    el,
    apply(dx, dy, ev) {
      let nx = startX + dx;
      let ny = startY + dy;
      if (ev?.shiftKey) {
        nx = snap(nx);
        ny = snap(ny);
      }
      b.x = nx;
      b.y = ny;
      el.style.left = b.x + "px";
      el.style.top = b.y + "px";
    },
  };
};

// Which corner grip a box-resize drag started from. Determines which
// edges follow the pointer and which stay pinned.
export type ResizeCorner = "tl" | "tr" | "bl" | "br";

// Floor for explicit box sizes. Width matches the CSS `min-width: 80px`
// on .box so the stored value never diverges from what actually renders;
// height covers one line of 16px text plus padding.
export const MIN_BOX_W = 80;
export const MIN_BOX_H = 36;

// Resize a box by dragging one of its corner grips. The opposite
// corner stays pinned: dragging `br` grows width/height directly,
// dragging `tl` moves x/y while the far edge holds still, and the
// mixed corners pin one axis each. Sizes are rounded to whole pixels
// — sub-pixel box sizes serialize noisily (Go's %g truncates to 6
// significant digits) and are visually meaningless. Shift snaps the
// dragged edges to the 20px grid. An auto-sized box materializes its
// current rendered size at drag start, so the first grip-pull feels
// like adjusting from "what I see", not from zero.
export const makeBoxResizeMover = (
  b: BoxLike,
  el: HTMLElement,
  corner: ResizeCorner,
): Mover => {
  const startX = b.x;
  const startY = b.y;
  const startW = b.w ?? el.offsetWidth;
  const startH = b.h ?? el.offsetHeight;
  const fromLeft = corner === "tl" || corner === "bl";
  const fromTop = corner === "tl" || corner === "tr";
  return {
    el,
    apply(dx, dy, ev) {
      let nw = fromLeft ? startW - dx : startW + dx;
      let nh = fromTop ? startH - dy : startH + dy;
      if (ev?.shiftKey) {
        nw = snap(nw);
        nh = snap(nh);
      }
      nw = Math.max(MIN_BOX_W, Math.round(nw));
      nh = Math.max(MIN_BOX_H, Math.round(nh));
      b.w = nw;
      b.h = nh;
      // Left/top-anchored drags reposition so the opposite edge pins.
      // Deriving x from the clamped width (rather than raw dx) keeps
      // the pinned edge exactly still when the min-size clamp kicks in.
      if (fromLeft) b.x = startX + (startW - nw);
      if (fromTop) b.y = startY + (startH - nh);
      el.style.width = nw + "px";
      el.style.height = nh + "px";
      el.style.left = b.x + "px";
      el.style.top = b.y + "px";
      el.classList.add("sized");
      // Re-budget the label's line clamp for the new frame so text
      // wraps / ellipsises live while the grip is being dragged.
      updateSizedLabelClamp(el);
    },
  };
};

// Hexagon boxes (shape = 1) drag freely until their centre comes
// within HEX_SNAP_RADIUS of another hexagon's centre; from there the
// position is magnetic — it snaps to the nearest FREE cell of the
// flat-top lattice anchored at that hexagon, so edges land flush and
// two hexes can never occupy the same cell. `otherHexCenters` must
// exclude every hex in the dragged selection (attach.ts does), or the
// selection would snap against itself.
//
// NOTE: hexagons keep their fixed HEX_W × HEX_H size — never write
// width/height here (or anywhere): resizing is a rectangle-only
// feature, and all the lattice math depends on the uniform size.
// Shift-grid snap is deliberately ignored: the hex lattice IS the grid.
export const makeHexMover = (
  b: BoxLike,
  el: HTMLElement,
  otherHexCenters: ReadonlyArray<{ x: number; y: number }>,
): Mover => {
  const startX = b.x;
  const startY = b.y;
  return {
    el,
    apply(dx, dy, _ev) {
      const cx = startX + dx + HEX_W / 2;
      const cy = startY + dy + HEX_H / 2;
      const snapped = snapHexCenter({ x: cx, y: cy }, otherHexCenters);
      b.x = (snapped?.x ?? cx) - HEX_W / 2;
      b.y = (snapped?.y ?? cy) - HEX_H / 2;
      el.style.left = b.x + "px";
      el.style.top = b.y + "px";
    },
  };
};

// Multi-hex drags: ONE controller moves every selected hexagon by a
// shared delta so the formation never deforms mid-drag. Snapping goes
// through snapHexGroup, which only accepts a lattice placement where
// the ENTIRE formation fits — otherwise the group keeps moving freely.
// (Per-hex movers used to snap members independently, tearing the
// group apart the moment it came near other hexes.)
//
// Returns one mover per member so the drag loop's `.dragging` class
// toggling reaches every element; only the first (controller) does
// any work, the rest are position-keepers.
export const makeHexGroupMovers = (
  members: ReadonlyArray<{ b: BoxLike; el: HTMLElement }>,
  otherHexCenters: ReadonlyArray<{ x: number; y: number }>,
): Mover[] => {
  const orig = members.map((m) => ({ m, x: m.b.x, y: m.b.y }));
  const controller: Mover = {
    el: members[0]!.el,
    apply(dx, dy, _ev) {
      const centers = orig.map((o) => ({
        x: o.x + dx + HEX_W / 2,
        y: o.y + dy + HEX_H / 2,
      }));
      const snap = snapHexGroup(centers, otherHexCenters);
      const ddx = dx + (snap?.x ?? 0);
      const ddy = dy + (snap?.y ?? 0);
      for (const o of orig) {
        o.m.b.x = o.x + ddx;
        o.m.b.y = o.y + ddy;
        o.m.el.style.left = o.m.b.x + "px";
        o.m.el.style.top = o.m.b.y + "px";
      }
    },
  };
  const shadows: Mover[] = members.slice(1).map((m) => ({
    el: m.el,
    apply() {
      /* moved by the controller */
    },
  }));
  return [controller, ...shadows];
};

export interface ImageLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Images move exactly like boxes — translate the top-left corner and
// mirror it onto the element's left/top.
export const makeImageMover = (img: ImageLike, el: HTMLElement): Mover => {
  const startX = img.x;
  const startY = img.y;
  return {
    el,
    apply(dx, dy, ev) {
      let nx = startX + dx;
      let ny = startY + dy;
      if (ev?.shiftKey) {
        nx = snap(nx);
        ny = snap(ny);
      }
      img.x = nx;
      img.y = ny;
      el.style.left = img.x + "px";
      el.style.top = img.y + "px";
    },
  };
};

// Resize from the bottom-right corner, preserving the image's captured
// aspect ratio (width drives, height follows). Shift snaps the new
// width to the grid. MIN_IMAGE keeps the asset from collapsing to an
// unclickable sliver.
const MIN_IMAGE = 20;
export const makeImageResizeMover = (
  img: ImageLike,
  el: HTMLElement,
): Mover => {
  const startW = img.width;
  const startH = img.height;
  const aspect = startH / startW || 1;
  return {
    el,
    apply(dx, _dy, ev) {
      let nw = startW + dx;
      if (ev?.shiftKey) nw = snap(nw);
      if (nw < MIN_IMAGE) nw = MIN_IMAGE;
      img.width = nw;
      img.height = Math.max(MIN_IMAGE, Math.round(nw * aspect));
      el.style.width = img.width + "px";
      el.style.height = img.height + "px";
    },
  };
};

export const makeTextMover = (t: TextLike, el: HTMLElement): Mover => {
  const startX = t.x;
  const startY = t.y;
  return {
    el,
    apply(dx, dy, ev) {
      let nx = startX + dx;
      let ny = startY + dy;
      if (ev?.shiftKey) {
        nx = snap(nx);
        ny = snap(ny);
      }
      t.x = nx;
      t.y = ny;
      el.style.left = t.x + "px";
      el.style.top = t.y + "px";
    },
  };
};

export const makeLineMover = (
  l: LineLike,
  gEl: SVGGElement,
  lineEl: SVGPathElement,
  hitEl: SVGPathElement,
  h1: SVGCircleElement | null,
  h2: SVGCircleElement | null,
  midHandles: SVGCircleElement[],
): Mover => {
  const startX1 = l.x1;
  const startY1 = l.y1;
  const startX2 = l.x2;
  const startY2 = l.y2;
  const startMids = (l.mids ?? []).map(([x, y]) => [x, y] as [number, number]);
  return {
    el: gEl,
    apply(dx, dy, ev) {
      let ddx = dx;
      let ddy = dy;
      if (ev?.shiftKey) {
        // Snap endpoint 1 to the grid; endpoint 2 (and all mids)
        // follow by the same offset so the line's shape is preserved.
        ddx = snap(startX1 + dx) - startX1;
        ddy = snap(startY1 + dy) - startY1;
      }
      l.x1 = startX1 + ddx;
      l.y1 = startY1 + ddy;
      l.x2 = startX2 + ddx;
      l.y2 = startY2 + ddy;
      if (startMids.length > 0) {
        if (!l.mids) l.mids = [];
        for (let i = 0; i < startMids.length; i++) {
          const o = startMids[i]!;
          l.mids[i] = [o[0] + ddx, o[1] + ddy];
        }
      }
      const d = linePathD(l);
      lineEl.setAttribute("d", d);
      hitEl.setAttribute("d", d);
      if (h1) {
        h1.setAttribute("cx", String(l.x1));
        h1.setAttribute("cy", String(l.y1));
      }
      if (h2) {
        h2.setAttribute("cx", String(l.x2));
        h2.setAttribute("cy", String(l.y2));
      }
      for (let i = 0; i < midHandles.length && i < (l.mids?.length ?? 0); i++) {
        const [mx, my] = l.mids![i]!;
        midHandles[i]!.setAttribute("cx", String(mx));
        midHandles[i]!.setAttribute("cy", String(my));
      }
    },
  };
};

// 1 / 2 are the two endpoints; a number ≥ 0 indexes into l.mids.
export type LineEndpoint = 1 | 2 | { mid: number };

export interface LineEndpointRefs {
  readonly g: SVGGElement;
  readonly line: SVGPathElement;
  readonly hit: SVGPathElement;
  readonly h1: SVGCircleElement;
  readonly h2: SVGCircleElement;
  readonly midHandles: SVGCircleElement[];
}

export const makeLineEndpointMover = (
  l: LineLike,
  endpoint: LineEndpoint,
  refs: LineEndpointRefs,
): Mover => {
  const midIdx = typeof endpoint === "object" ? endpoint.mid : -1;
  const startX =
    endpoint === 1
      ? l.x1
      : endpoint === 2
      ? l.x2
      : (l.mids?.[midIdx]?.[0] ?? 0);
  const startY =
    endpoint === 1
      ? l.y1
      : endpoint === 2
      ? l.y2
      : (l.mids?.[midIdx]?.[1] ?? 0);
  return {
    el: refs.g,
    apply(dx, dy, ev) {
      let nx = startX + dx;
      let ny = startY + dy;
      if (ev?.shiftKey) {
        nx = snap(nx);
        ny = snap(ny);
      }
      if (endpoint === 1) {
        l.x1 = nx;
        l.y1 = ny;
      } else if (endpoint === 2) {
        l.x2 = nx;
        l.y2 = ny;
      } else if (l.mids && l.mids[midIdx]) {
        l.mids[midIdx] = [nx, ny];
      }
      const d = linePathD(l);
      refs.line.setAttribute("d", d);
      refs.hit.setAttribute("d", d);
      const h =
        endpoint === 1
          ? refs.h1
          : endpoint === 2
          ? refs.h2
          : (refs.midHandles[midIdx] ?? null);
      if (h) {
        h.setAttribute("cx", String(nx));
        h.setAttribute("cy", String(ny));
      }
    },
  };
};

export interface StrokeLike {
  points: Array<[number, number]>;
}

// Strokes translate as a rigid body: capture the original points at
// construction, then on each tick rewrite each point by (dx, dy) and
// re-emit the SVG path d. Both the visible .stroke-line and the wider
// transparent .stroke-hit share the same d so the hit area follows
// the stroke during the drag.
export const makeStrokeMover = (
  s: StrokeLike,
  gEl: SVGGElement,
  hitEl: SVGPathElement,
  lineEl: SVGPathElement,
): Mover => {
  const orig = s.points.map(([x, y]) => [x, y] as [number, number]);
  return {
    el: gEl,
    apply(dx, dy, ev) {
      let ddx = dx;
      let ddy = dy;
      if (ev?.shiftKey && orig.length > 0) {
        // Snap the first point to the grid; the rest translate by the
        // same offset so the stroke's shape is preserved.
        const p0 = orig[0]!;
        ddx = snap(p0[0] + dx) - p0[0];
        ddy = snap(p0[1] + dy) - p0[1];
      }
      for (let i = 0; i < orig.length; i++) {
        const o = orig[i]!;
        s.points[i] = [o[0] + ddx, o[1] + ddy];
      }
      const d = strokePathD(s.points);
      hitEl.setAttribute("d", d);
      lineEl.setAttribute("d", d);
    },
  };
};

// HandleCode re-export keeps callers from importing both modules just
// to spell the type out.
export type { HandleCode };
