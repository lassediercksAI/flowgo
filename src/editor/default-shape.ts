// Per-FILE default shape: what a double-click (or touch double-tap)
// on empty canvas creates. Stored on the graph itself
// (graph.defaultShape, the `defaultshape <n>` directive) so the map
// carries its own preference everywhere it opens — this replaced the
// old per-browser hexagon setting (localStorage flowgo.hexagons, the
// ⚙ popover entry, the ⬡ mode-bar latch and window.FLOWGO_HEXAGON,
// all retired).
//
// Changed via Shift+1..4 with nothing selected in plain cursor mode
// (keys.ts) or the set_default_shape MCP tool; factories.ts consults
// getDefaultShape() inside every box-creation path.

import { SHAPE_NAMES } from "../graph/shape.ts";
import { mutatedDoc } from "./mutations.ts";

interface GraphWithDefault {
  defaultShape?: number;
}

interface DefaultShapeBindings {
  readonly getGraph: () => GraphWithDefault;
  readonly setStatus: (s: string) => void;
}

let bindings: DefaultShapeBindings | null = null;
const must = (): DefaultShapeBindings => {
  if (!bindings) throw new Error("default-shape: wireDefaultShape() not called");
  return bindings;
};

export const wireDefaultShape = (b: DefaultShapeBindings): void => {
  bindings = b;
};

export const getDefaultShape = (): number =>
  must().getGraph().defaultShape ?? 0;

export const setDefaultShape = (shape: number): void => {
  const g = must().getGraph();
  const cur = g.defaultShape ?? 0;
  const name = SHAPE_NAMES[shape] ?? "rectangle";
  if (cur === shape) {
    must().setStatus(`default shape already ${name}`);
    return;
  }
  if (shape) g.defaultShape = shape;
  else delete g.defaultShape;
  mutatedDoc();
  must().setStatus(
    `default shape: ${name} — double-click creates ${name}s (saved with this map)`,
  );
};
