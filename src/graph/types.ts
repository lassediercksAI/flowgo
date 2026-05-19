// Shape primitives shared by every helper. Keeping them in one place
// means a function signature like `polygonAnchor(box, ...)` documents
// itself: a Box2D is "x, y, width, height", a Vec2 is "x, y", full stop.

export type Vec2 = readonly [x: number, y: number];

export interface Box2D {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
