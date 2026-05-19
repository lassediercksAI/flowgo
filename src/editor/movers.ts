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
