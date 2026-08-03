// Segment-vs-rectangle intersection (Liang–Barsky clip). Used by the
// rubber-band selection to test a polyline's actual segments against
// the band instead of the polyline's bounding box — an L-shaped line
// must not be selectable from the empty corner of its bbox (#1f8).

// True iff the closed segment (ax,ay)→(bx,by) intersects the
// axis-aligned rectangle [x1..x2] × [y1..y2] (touching counts).
// Callers guarantee x1 <= x2 and y1 <= y2.
export const segIntersectsRect = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean => {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  // Clip the parametric segment against one half-plane p·t <= q. Returns
  // false as soon as the remaining [t0, t1] window empties.
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel: inside iff on the inner side
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, ax - x1) &&
    clip(dx, x2 - ax) &&
    clip(-dy, ay - y1) &&
    clip(dy, y2 - ay)
  );
};

// True iff any consecutive segment of the polyline through `points`
// intersects the rectangle. Single-point "polylines" degenerate to a
// point-in-rect test.
export const polylineIntersectsRect = (
  points: ReadonlyArray<readonly [number, number]>,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean => {
  if (points.length === 1) {
    const [px, py] = points[0]!;
    return px >= x1 && px <= x2 && py >= y1 && py <= y2;
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const [pax, pay] = points[i]!;
    const [pbx, pby] = points[i + 1]!;
    if (segIntersectsRect(pax, pay, pbx, pby, x1, y1, x2, y2)) return true;
  }
  return false;
};
