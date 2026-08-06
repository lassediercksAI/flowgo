// Memoized id minting (brain#24f). The cache is a correctness-
// sensitive optimisation — a stale entry means a DUPLICATE id in the
// user's file — so the suite is a parity fuzz against the naive
// "collect every id, probe from 1" form these functions replaced,
// plus explicit tests for each invalidation trigger.

import { beforeEach, describe, expect, it } from "vitest";
import { invalidateUidCache, mintId, wireUid } from "./uid.ts";
import { mutatedBox, wireMutations } from "./mutations.ts";
import { collectIds, nextUid } from "../graph/id.ts";

interface Item { id: string }
interface TestMap {
  boxes: Item[];
  texts: Item[];
  lines: Item[];
  strokes: Item[];
  images: Item[];
}

const emptyMap = (): TestMap => ({
  boxes: [], texts: [], lines: [], strokes: [], images: [],
});

// The implementation this replaced, kept verbatim as the oracle.
const naiveMint = (prefix: string, m: TestMap): string =>
  nextUid(prefix, collectIds(m.boxes, m.texts, m.lines, m.strokes, m.images));

let map: TestMap;

beforeEach(() => {
  map = emptyMap();
  wireUid({ currentMap: () => map });
  wireMutations({ scheduleSave: () => {} });
});

describe("mintId", () => {
  it("hands out sequential ids within one burst without touching the map", () => {
    map.boxes = [{ id: "b1" }, { id: "b2" }];
    // Nothing is pushed back into the map between mints — the burst
    // still may not repeat itself (this is what a paste does).
    expect([mintId("b"), mintId("b"), mintId("b")]).toEqual(["b3", "b4", "b5"]);
  });

  it("keeps a separate cursor per prefix", () => {
    map.boxes = [{ id: "b1" }];
    map.texts = [{ id: "t1" }, { id: "t2" }];
    expect(mintId("b")).toBe("b2");
    expect(mintId("t")).toBe("t3");
    expect(mintId("b")).toBe("b3");
    expect(mintId("t")).toBe("t4");
  });

  it("defaults to the box prefix", () => {
    map.boxes = [{ id: "b1" }];
    expect(mintId()).toBe("b2");
  });

  it("skips ids taken by any layer, not just boxes", () => {
    map.lines = [{ id: "x1" }];
    map.images = [{ id: "x2" }];
    map.strokes = [{ id: "x3" }];
    expect(mintId("x")).toBe("x4");
  });

  it("reuses a freed id once the mutation chokepoint has fired", () => {
    map.boxes = [{ id: "b1" }, { id: "b2" }, { id: "b3" }];
    expect(mintId("b")).toBe("b4");
    // Delete b2 the way a real deletion does: mutate, then announce.
    map.boxes = map.boxes.filter((b) => b.id !== "b2");
    mutatedBox();
    // Smallest-free-integer semantics survive the memoization.
    expect(mintId("b")).toBe("b2");
  });

  it("does not hand out an id that is still live after invalidation", () => {
    map.boxes = [{ id: "b1" }];
    const first = mintId("b");
    map.boxes.push({ id: first });
    invalidateUidCache();
    expect(mintId("b")).not.toBe(first);
  });

  it("rebuilds when the current map is swapped (navigation / undo)", () => {
    map.boxes = [{ id: "b1" }, { id: "b2" }];
    expect(mintId("b")).toBe("b3");
    // Map switch replaces the state slice without any local mutation.
    map = emptyMap();
    expect(mintId("b")).toBe("b1");
  });

  it("reserves minted ids across prefixes, not just within one", () => {
    // "b1" + 1 and "b" + 11 are the same string: the per-prefix cursor
    // alone cannot see that collision, so every minted id is also
    // added to the shared used-set before it is handed out.
    expect(mintId("b1")).toBe("b11");
    const ids = new Set<string>(["b11"]);
    for (let i = 0; i < 12; i++) {
      const id = mintId("b");
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  });

  it("scans the map once per burst, not once per minted id", () => {
    // The whole point of the cache. Counting rebuilds instead of
    // milliseconds keeps this machine-independent: mintId only reads
    // the layer arrays when it (re)builds the used-id set.
    let scans = 0;
    const boxes: Item[] = Array.from({ length: 500 }, (_, i) => ({ id: "b" + (i + 1) }));
    const counting = {
      get boxes() { scans++; return boxes; },
      texts: [], lines: [], strokes: [], images: [],
    };
    wireUid({ currentMap: () => counting });

    for (let i = 0; i < 200; i++) mintId("b");
    expect(scans).toBe(1);

    // …and exactly one more after the next mutation.
    mutatedBox();
    mintId("b");
    expect(scans).toBe(2);
  });

  it("throws before wiring", () => {
    wireUid(null as unknown as { currentMap: () => TestMap });
    expect(() => mintId("b")).toThrow(/wireUid/);
  });
});

describe("parity fuzz against the naive mint", () => {
  it("matches the collect-everything-and-probe-from-1 form", () => {
    // Deterministic LCG, same convention as the other perf-adjacent
    // suites — a failure is reproducible to the step.
    let s = 0x24f0001;
    const rnd = (n: number): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return Math.floor((s / 0x100000000) * n);
    };
    const prefixes = ["b", "t", "l", "s"] as const;
    const layerOf = (p: string): Item[] =>
      p === "b" ? map.boxes
        : p === "t" ? map.texts
          : p === "l" ? map.lines
            : map.strokes;

    for (let step = 0; step < 600; step++) {
      const op = rnd(10);
      const p = prefixes[rnd(prefixes.length)]!;
      if (op < 6) {
        // Mint one id and commit it — must match the oracle exactly.
        const expected = naiveMint(p, map);
        expect(mintId(p), `step ${step}`).toBe(expected);
        layerOf(p).push({ id: expected });
      } else if (op < 8) {
        // Bulk mint (a paste): every id distinct and unused, and the
        // resulting map must agree with the oracle afterwards.
        const n = 1 + rnd(12);
        const minted: string[] = [];
        for (let i = 0; i < n; i++) minted.push(mintId(p));
        expect(new Set(minted).size, `step ${step}`).toBe(n);
        for (const id of minted) {
          expect(collectIds(map.boxes, map.texts, map.lines, map.strokes, map.images).has(id))
            .toBe(false);
          layerOf(p).push({ id });
        }
      } else {
        // Delete something, then announce it through the chokepoint.
        const layer = layerOf(p);
        if (layer.length > 0) layer.splice(rnd(layer.length), 1);
        mutatedBox();
      }
    }
  });
});
