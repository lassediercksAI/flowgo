// The per-file default shape (graph.defaultShape) decides what a
// double-click / double-tap creates; factories.ts consults
// getDefaultShape() inside every box-creation path, so the whole
// decision table is pinned here: absence means rectangle, 0 is stored
// AS absence (the `defaultshape` directive only exists for real
// overrides), a repeated set is a status-only no-op that must not dirty
// the document, and unknown ids pass through (they render as
// rectangles downstream via fixedShapeSize's null).
//
// Pure state + strings — no DOM — so this runs in the node default.

import { beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultShape,
  setDefaultShape,
  wireDefaultShape,
} from "./default-shape.ts";
import { wireMutations } from "./mutations.ts";
import {
  SHAPE_CIRCLE,
  SHAPE_HEX,
  SHAPE_RECT,
  SHAPE_TRIANGLE,
} from "../graph/shape.ts";

interface G {
  defaultShape?: number;
}

// Module-level bindings persist for the life of the file, so the
// unwired contract must be pinned before anything calls
// wireDefaultShape — vitest runs a file's suites in declaration order.
describe("unwired module", () => {
  it("getDefaultShape throws until wireDefaultShape() is called", () => {
    expect(() => getDefaultShape()).toThrow(/wireDefaultShape\(\) not called/);
  });

  it("setDefaultShape throws until wireDefaultShape() is called", () => {
    expect(() => setDefaultShape(SHAPE_HEX)).toThrow(
      /wireDefaultShape\(\) not called/,
    );
  });
});

describe("wired", () => {
  let graph: G;
  let saves: number;
  let status: string[];

  beforeEach(() => {
    graph = {};
    saves = 0;
    status = [];
    wireDefaultShape({
      getGraph: () => graph,
      setStatus: (s) => status.push(s),
    });
    // setDefaultShape dirties the document through mutatedDoc(), which
    // requires the mutation chokepoint to be wired; `saves` is how the
    // tests observe "the doc was (not) dirtied".
    wireMutations({ scheduleSave: () => saves++ });
  });

  describe("getDefaultShape", () => {
    it("reads rectangle (0) from a graph with no directive", () => {
      expect(getDefaultShape()).toBe(SHAPE_RECT);
    });

    it("reads the stored shape id verbatim", () => {
      for (const s of [SHAPE_HEX, SHAPE_CIRCLE, SHAPE_TRIANGLE]) {
        graph.defaultShape = s;
        expect(getDefaultShape()).toBe(s);
      }
    });
  });

  describe("setDefaultShape — decision table", () => {
    it("stores a new non-rectangle shape and dirties the doc", () => {
      setDefaultShape(SHAPE_HEX);
      expect(graph.defaultShape).toBe(SHAPE_HEX);
      expect(saves).toBe(1);
      // Exact wording once: the status is user-facing UI copy.
      expect(status).toEqual([
        "default shape: hexagon — double-click creates hexagons (saved with this map)",
      ]);
    });

    it("names circle and triangle in their confirmations", () => {
      setDefaultShape(SHAPE_CIRCLE);
      expect(graph.defaultShape).toBe(SHAPE_CIRCLE);
      expect(status.at(-1)).toMatch(/default shape: circle\b/);
      setDefaultShape(SHAPE_TRIANGLE);
      expect(graph.defaultShape).toBe(SHAPE_TRIANGLE);
      expect(status.at(-1)).toMatch(/default shape: triangle\b/);
    });

    it("replaces one override with another", () => {
      graph.defaultShape = SHAPE_HEX;
      setDefaultShape(SHAPE_CIRCLE);
      expect(graph.defaultShape).toBe(SHAPE_CIRCLE);
      expect(saves).toBe(1);
    });

    it("re-setting the current shape is a status-only no-op", () => {
      graph.defaultShape = SHAPE_CIRCLE;
      setDefaultShape(SHAPE_CIRCLE);
      expect(graph.defaultShape).toBe(SHAPE_CIRCLE);
      expect(saves).toBe(0); // must NOT dirty the document
      expect(status).toEqual(["default shape already circle"]);
    });

    it("setting rectangle on a directive-free graph is also a no-op", () => {
      // Absence ≡ 0, so this is "already rectangle" — and crucially it
      // must not materialize a defaultShape key out of thin air.
      setDefaultShape(SHAPE_RECT);
      expect("defaultShape" in graph).toBe(false);
      expect(saves).toBe(0);
      expect(status).toEqual(["default shape already rectangle"]);
    });

    it("setting rectangle DELETES the directive rather than storing 0", () => {
      graph.defaultShape = SHAPE_TRIANGLE;
      setDefaultShape(SHAPE_RECT);
      // Serialization relies on absence: `defaultshape 0` never hits
      // the wire because rectangle is the built-in default.
      expect("defaultShape" in graph).toBe(false);
      expect(getDefaultShape()).toBe(SHAPE_RECT);
      expect(saves).toBe(1);
      expect(status.at(-1)).toMatch(/default shape: rectangle\b/);
    });

    it("an unknown shape id is stored but announced as rectangle", () => {
      // Pins today's fallback: ids outside SHAPE_NAMES pass straight
      // through to the graph (they render as rectangles downstream,
      // fixedShapeSize → null) while the status falls back to the
      // "rectangle" wording.
      setDefaultShape(7);
      expect(graph.defaultShape).toBe(7);
      expect(getDefaultShape()).toBe(7);
      expect(saves).toBe(1);
      expect(status.at(-1)).toMatch(/default shape: rectangle\b/);
    });
  });
});
