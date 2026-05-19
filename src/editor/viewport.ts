// Viewport: pan offset + the small bundle of helpers that translate
// between screen and canvas-data coordinates and reposition every
// canvas-aligned SVG layer when the viewport moves.
//
// The viewport object is exported as a stable mutable reference so
// pan / drag / undo handlers can write to `viewport.x` / `.y` and
// then call applyViewport() to redraw — keeps the live-binding
// semantics callers expect from the previous module-global.

export const viewport: { x: number; y: number } = { x: 0, y: 0 };

export const toDataX = (clientX: number): number => clientX - viewport.x;
export const toDataY = (clientY: number): number => clientY - viewport.y;

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`viewport: missing #${id}`);
  return el;
};

export const applyViewport = (): void => {
  const tx = viewport.x;
  const ty = viewport.y;
  byId("canvas").style.transform = `translate(${tx}px, ${ty}px)`;
  for (const layer of ["line-layer", "stroke-layer", "edge-layer"]) {
    byId(layer).setAttribute("transform", `translate(${tx} ${ty})`);
  }
  byId("ghost-line").setAttribute("transform", `translate(${tx} ${ty})`);
  byId("bg-layer").style.backgroundPosition = `${tx}px ${ty}px`;
};

// Centre the camera. Priority order:
//   1. The map's anchor box (the one with `anchor: true`).
//   2. A box with id "b1" — the conventional first box (back-compat
//      so older maps without an explicit anchor still centre nicely).
//   3. The bounding box of every concrete piece on the map.
// Side effects: mutates `viewport` and replays applyViewport.
export const recenter = (currentMap: {
  readonly boxes?: ReadonlyArray<{
    readonly id?: string;
    readonly x: number;
    readonly y: number;
    readonly anchor?: boolean;
  }>;
  readonly texts?: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  readonly lines?: ReadonlyArray<{
    readonly x1: number; readonly y1: number;
    readonly x2: number; readonly y2: number;
    readonly mids?: ReadonlyArray<readonly [number, number]>;
  }>;
}): void => {
  const boxes = currentMap.boxes ?? [];
  const target = boxes.find((b) => b.anchor) ?? boxes.find((b) => b.id === "b1");
  if (target && target.id) {
    // Prefer the rendered element's true centre; fall back to the
    // stored top-left (matches existing bbox math for single-point
    // maps) if the element isn't in the DOM yet.
    const el = document.querySelector<HTMLElement>(
      `.box[data-id="${target.id}"]`,
    );
    const cx = target.x + (el ? el.offsetWidth / 2 : 0);
    const cy = target.y + (el ? el.offsetHeight / 2 : 0);
    viewport.x = window.innerWidth / 2 - cx;
    viewport.y = window.innerHeight / 2 - cy;
    applyViewport();
    return;
  }

  const points: Array<readonly [number, number]> = [];
  for (const b of currentMap.boxes ?? []) points.push([b.x, b.y]);
  for (const t of currentMap.texts ?? []) points.push([t.x, t.y]);
  for (const l of currentMap.lines ?? []) {
    points.push([l.x1, l.y1]);
    points.push([l.x2, l.y2]);
    for (const [mx, my] of l.mids ?? []) points.push([mx, my]);
  }
  if (points.length === 0) {
    viewport.x = 0;
    viewport.y = 0;
  } else {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    viewport.x = window.innerWidth / 2 - cx;
    viewport.y = window.innerHeight / 2 - cy;
  }
  applyViewport();
};
