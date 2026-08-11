// Invariant repair on arrival (persistence.ts settleGraphHexes): a
// document fetched from /state can carry overlapping hexagons — raw
// imports, hand-edited files, pre-snap MCP writers — and the editor
// must put a settled, flush lattice on screen instead of a stack.
// Harness mirrors persistence-live.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDirty, load, refreshFromServer, wirePersistence } from "./persistence.ts";
import { HEX_H, HEX_W, hexesOverlap } from "../graph/hex.ts";

type BoxLike = { id: string; label: string; x: number; y: number; shape?: number };
type MapLike = { path: string; boxes?: BoxLike[]; edges?: unknown[] };
type GraphLike = { maps: MapLike[] };

// Five hexagons stacked at 20px offsets — the pathological input the
// GUI itself can never produce.
const stackedHexDoc = (): GraphLike => ({
  maps: [
    {
      path: "/",
      boxes: Array.from({ length: 5 }, (_, i) => ({
        id: "h" + i,
        label: "hex",
        x: 100 + 20 * i,
        y: 100 + 20 * i,
        shape: 1,
      })),
      edges: [],
    },
  ],
});

const centers = (g: GraphLike): Array<{ x: number; y: number }> =>
  (g.maps[0]!.boxes ?? []).map((b) => ({ x: b.x + HEX_W / 2, y: b.y + HEX_H / 2 }));

const expectNoOverlap = (g: GraphLike): void => {
  const c = centers(g);
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length; j++) {
      expect(hexesOverlap(c[i]!, c[j]!)).toBe(false);
    }
  }
};

let graph: GraphLike;
let stateBody: string;
let stateRevision: string;

beforeEach(() => {
  graph = { maps: [] };
  stateBody = JSON.stringify(stackedHexDoc());
  stateRevision = "1";
  vi.stubGlobal("fetch", (url: string) => {
    if (String(url).startsWith("/state")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k === "X-Flowgo-Revision" ? stateRevision : null) },
        json: () => Promise.resolve(JSON.parse(stateBody)),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 204,
      headers: { get: () => stateRevision },
    } as unknown as Response);
  });
  wirePersistence({
    getGraph: () => graph,
    setGraph: (g) => { graph = g as GraphLike; },
    serializeGraph: () => "",
    setCurrentPath: () => {},
    getCurrentPath: () => "/",
    readPathFromURL: () => "/",
    readViewFromURL: () => null,
    applyURLView: () => {},
    setStatus: () => {},
    clearSelected: () => {},
    clearSelectedEdge: () => {},
  });
});

describe("hex settle on load", () => {
  it("puts a flush lattice on screen instead of a stack", async () => {
    await load();
    expect(graph.maps[0]!.boxes).toHaveLength(5);
    expectNoOverlap(graph);
  });

  it("keeps the document clean — settling is the baseline, not an edit", async () => {
    await load();
    expect(isDirty()).toBe(false);
  });

  it("leaves rectangles exactly where the file put them", async () => {
    const doc: GraphLike = {
      maps: [
        {
          path: "/",
          boxes: [
            { id: "r0", label: "a", x: 100, y: 100 },
            { id: "r1", label: "b", x: 110, y: 110 },
          ],
          edges: [],
        },
      ],
    };
    stateBody = JSON.stringify(doc);
    await load();
    expect(graph.maps[0]!.boxes![0]).toMatchObject({ x: 100, y: 100 });
    expect(graph.maps[0]!.boxes![1]).toMatchObject({ x: 110, y: 110 });
  });
});

describe("hex settle on live refresh", () => {
  it("settles a stacked document arriving over the event stream", async () => {
    stateBody = JSON.stringify({
      maps: [{ path: "/", boxes: [], edges: [] }],
    });
    await load();
    stateBody = JSON.stringify(stackedHexDoc());
    stateRevision = "2";
    expect(await refreshFromServer()).toBe("applied");
    expect(graph.maps[0]!.boxes).toHaveLength(5);
    expectNoOverlap(graph);
  });
});
