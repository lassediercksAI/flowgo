// Drag movers: factories that produce { el, apply(dx, dy, ev) } for
// each kind of draggable item. The mover stores its starting position
// at construction so the drag handler can compute new positions from a
// pointer delta and apply them to both the data object and the DOM.
//
// Shift-snap is shared via the GRID + snap helpers; it lives here
// because all movers need it and nothing else in the editor cares.

import type { HandleCode } from "../graph/handle.ts";
import { strokePathD } from "../graph/stroke.ts";

export const GRID = 20;
export const snap = (v: number): number => Math.round(v / GRID) * GRID;

export interface BoxLike {
  x: number;
  y: number;
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
}

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
  lineEl: SVGLineElement,
  hitEl: SVGLineElement,
  h1: SVGCircleElement | null,
  h2: SVGCircleElement | null,
): Mover => {
  const startX1 = l.x1;
  const startY1 = l.y1;
  const startX2 = l.x2;
  const startY2 = l.y2;
  return {
    el: gEl,
    apply(dx, dy, ev) {
      let ddx = dx;
      let ddy = dy;
      if (ev?.shiftKey) {
        // Snap endpoint 1 to the grid; endpoint 2 follows by the same offset.
        ddx = snap(startX1 + dx) - startX1;
        ddy = snap(startY1 + dy) - startY1;
      }
      l.x1 = startX1 + ddx;
      l.y1 = startY1 + ddy;
      l.x2 = startX2 + ddx;
      l.y2 = startY2 + ddy;
      for (const e of [lineEl, hitEl]) {
        e.setAttribute("x1", String(l.x1));
        e.setAttribute("y1", String(l.y1));
        e.setAttribute("x2", String(l.x2));
        e.setAttribute("y2", String(l.y2));
      }
      if (h1) {
        h1.setAttribute("cx", String(l.x1));
        h1.setAttribute("cy", String(l.y1));
      }
      if (h2) {
        h2.setAttribute("cx", String(l.x2));
        h2.setAttribute("cy", String(l.y2));
      }
    },
  };
};

export interface LineEndpointRefs {
  readonly g: SVGGElement;
  readonly line: SVGLineElement;
  readonly hit: SVGLineElement;
  readonly h1: SVGCircleElement;
  readonly h2: SVGCircleElement;
}

export const makeLineEndpointMover = (
  l: LineLike,
  endpoint: 1 | 2,
  refs: LineEndpointRefs,
): Mover => {
  const startX = endpoint === 1 ? l.x1 : l.x2;
  const startY = endpoint === 1 ? l.y1 : l.y2;
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
      } else {
        l.x2 = nx;
        l.y2 = ny;
      }
      const xa = endpoint === 1 ? "x1" : "x2";
      const ya = endpoint === 1 ? "y1" : "y2";
      for (const e of [refs.line, refs.hit]) {
        e.setAttribute(xa, String(nx));
        e.setAttribute(ya, String(ny));
      }
      const h = endpoint === 1 ? refs.h1 : refs.h2;
      h.setAttribute("cx", String(nx));
      h.setAttribute("cy", String(ny));
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
