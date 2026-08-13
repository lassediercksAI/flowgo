// Unit tests for alt-drag selection cloning. Runs in vitest's node
// environment: cloneSelection mutates the data map and returns the id
// map — rendering is the caller's job (see render-bulk.test.ts for the
// DOM half). The bug class pinned throughout: a clone must mint FRESH
// ids everywhere — including inside edges — and must deep-copy nested
// arrays, or the copy stays entangled with its source.

import { describe, expect, it, vi } from "vitest";
import { cloneEdgesForIdMap, cloneSelection, wireClone } from "./clone.ts";

interface Box {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
  w?: number;
  h?: number;
  shape?: number;
}
interface Text {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
}
interface Line {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  palette?: number;
  mids?: Array<[number, number]>;
  style?: number;
}
interface Img {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Edge {
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
  palette?: number;
  label?: string;
}

interface State {
  boxes: Box[];
  texts: Text[];
  lines: Line[];
  edges: Edge[];
  images?: Img[];
  selected: Set<string>;
}

const makeState = (): State => ({
  boxes: [],
  texts: [],
  lines: [],
  edges: [],
  selected: new Set(),
});

// Deterministic mint that matches the real uid()'s prefix contract
// ("b" | "t" | "l" | "img") so id-shape assertions mean something.
const wire = (s: State): void => {
  let n = 0;
  wireClone({
    currentMap: () => s,
    selected: s.selected,
    findTextById: (id) => s.texts.find((t) => t.id === id),
    findLineById: (id) => s.lines.find((l) => l.id === id),
    findImageById: (id) => (s.images ?? []).find((i) => i.id === id),
    mintId: (p) => `${p}_new${++n}`,
  });
};

// wireClone stores module-level bindings that persist across tests, so
// every test re-wires its own fresh state before calling in.

describe("box cloning", () => {
  it("appends a copy with a fresh id and reports it in the id map", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "alpha", x: 10, y: 20 }];
    s.selected = new Set(["b1"]);
    wire(s);

    const idMap = cloneSelection();

    expect(s.boxes).toHaveLength(2);
    const copy = s.boxes[1]!;
    // Fresh id — colliding with the source graph is the classic bug.
    expect(copy.id).not.toBe("b1");
    expect(copy).toMatchObject({ label: "alpha", x: 10, y: 20 });
    expect(idMap.get("b1")).toBe(copy.id);
    expect(idMap.size).toBe(1);
    // The original is untouched (the drag that follows moves the copy).
    expect(s.boxes[0]).toEqual({ id: "b1", label: "alpha", x: 10, y: 20 });
  });

  it("copies palette/font/shape only when set, and omits absent ones", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "styled", x: 0, y: 0, palette: 4, font: 3, shape: 1 },
      { id: "b2", label: "plain", x: 100, y: 0 },
    ];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    cloneSelection();

    const styled = s.boxes.find((b) => b.label === "styled" && b.id !== "b1")!;
    const plain = s.boxes.find((b) => b.label === "plain" && b.id !== "b2")!;
    expect(styled).toMatchObject({ palette: 4, font: 3, shape: 1 });
    // Absent means ABSENT, not undefined/0 — serialization diffs and
    // the hexagon mover both key off property presence.
    expect("palette" in plain).toBe(false);
    expect("font" in plain).toBe(false);
    expect("shape" in plain).toBe(false);
  });

  it("copies explicit size only when both w and h are present", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "sized", x: 0, y: 0, w: 200, h: 120 },
      // Half-sized boxes exist only as corrupt input; the guard drops
      // the fragment rather than cloning an unrenderable size.
      { id: "b2", label: "halfsized", x: 0, y: 0, w: 200 },
    ];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    cloneSelection();

    const sized = s.boxes.find((b) => b.label === "sized" && b.id !== "b1")!;
    const half = s.boxes.find((b) => b.label === "halfsized" && b.id !== "b2")!;
    expect(sized).toMatchObject({ w: 200, h: 120 });
    expect("w" in half).toBe(false);
    expect("h" in half).toBe(false);
  });
});

describe("text, line, and image cloning", () => {
  it("clones a text with the t prefix and its optional styling", () => {
    const s = makeState();
    s.texts = [{ id: "t1", label: "note", x: 5, y: 6, palette: 2, font: 5 }];
    s.selected = new Set(["t1"]);
    wire(s);

    const idMap = cloneSelection();

    expect(s.texts).toHaveLength(2);
    const copy = s.texts[1]!;
    expect(copy.id).toBe("t_new1");
    expect(copy).toEqual({ id: "t_new1", label: "note", x: 5, y: 6, palette: 2, font: 5 });
    expect(idMap.get("t1")).toBe("t_new1");
  });

  it("clones a line and DEEP-copies its mids waypoints", () => {
    const s = makeState();
    s.lines = [{
      id: "l1", x1: 0, y1: 0, x2: 100, y2: 50,
      palette: 3, style: 2, mids: [[10, 10], [50, 40]],
    }];
    s.selected = new Set(["l1"]);
    wire(s);

    cloneSelection();

    const copy = s.lines[1]!;
    expect(copy).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 50, palette: 3, style: 2 });
    expect(copy.mids).toEqual([[10, 10], [50, 40]]);
    // Nested-array aliasing is the classic clone bug: dragging a
    // waypoint on the copy must not warp the original.
    copy.mids![0]![0] = 999;
    expect(s.lines[0]!.mids![0]![0]).toBe(10);
    // And the outer array must be fresh too.
    expect(copy.mids).not.toBe(s.lines[0]!.mids);
  });

  it("omits mids on the copy when the source has none (or an empty list)", () => {
    const s = makeState();
    s.lines = [
      { id: "l1", x1: 0, y1: 0, x2: 10, y2: 10 },
      { id: "l2", x1: 0, y1: 0, x2: 20, y2: 20, mids: [] },
    ];
    s.selected = new Set(["l1", "l2"]);
    wire(s);

    cloneSelection();

    const copies = s.lines.slice(2);
    expect(copies).toHaveLength(2);
    for (const c of copies) expect("mids" in c).toBe(false);
  });

  it("clones an image (shared src) and lazily creates the images array", () => {
    const s = makeState();
    // A map deserialized from JSON can lack the images key entirely;
    // findImageById is fed from elsewhere, mirroring the real wiring.
    const pool: Img[] = [
      { id: "img1", src: "flowgo-media/a.png", x: 1, y: 2, width: 30, height: 40 },
    ];
    wireClone({
      currentMap: () => s,
      selected: s.selected,
      findTextById: () => undefined,
      findLineById: () => undefined,
      findImageById: (id) => pool.find((i) => i.id === id),
      mintId: (p) => `${p}_new1`,
    });
    s.selected.add("img1");

    const idMap = cloneSelection();

    // The lazily-created array must stick on the live map object.
    expect(s.images).toHaveLength(1);
    expect(s.images![0]).toEqual({
      id: "img_new1", src: "flowgo-media/a.png", x: 1, y: 2, width: 30, height: 40,
    });
    expect(idMap.get("img1")).toBe("img_new1");
  });
});

describe("edge duplication between clones", () => {
  it("re-points the duplicated edge at the NEW box ids", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "a", x: 0, y: 0 },
      { id: "b2", label: "b", x: 100, y: 0 },
    ];
    s.edges = [{ from: "b1", to: "b2" }];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    const idMap = cloneSelection();

    expect(s.edges).toHaveLength(2);
    // The copy must reference the clones — an edge still pointing at
    // b1/b2 would silently double-link the originals.
    expect(s.edges[1]).toEqual({ from: idMap.get("b1"), to: idMap.get("b2") });
  });

  it("keeps handles, palette, and label on the duplicated edge (brain#266)", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "a", x: 0, y: 0 },
      { id: "b2", label: "b", x: 100, y: 0 },
    ];
    s.edges = [{
      from: "b1", fromHandle: "e", to: "b2", toHandle: "w",
      palette: 5, label: "depends on",
    }];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    cloneSelection();

    expect(s.edges[1]).toMatchObject({
      fromHandle: "e", toHandle: "w", palette: 5, label: "depends on",
    });
  });

  it("emits a bare {from,to} when the source edge has no extras", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "a", x: 0, y: 0 },
      { id: "b2", label: "b", x: 100, y: 0 },
    ];
    s.edges = [{ from: "b1", to: "b2" }];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    cloneSelection();

    // exactOptionalPropertyTypes discipline: no `fromHandle: undefined`
    // keys leaking into the persisted document.
    expect(Object.keys(s.edges[1]!).sort()).toEqual(["from", "to"]);
  });

  it("drops edges that reach outside the cloned set (no dangling refs)", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "a", x: 0, y: 0 },
      { id: "b2", label: "b", x: 100, y: 0 },
      { id: "b3", label: "c", x: 200, y: 0 },
    ];
    s.edges = [
      { from: "b1", to: "b2" }, // both cloned → duplicated
      { from: "b2", to: "b3" }, // b3 not cloned → not duplicated
      { from: "b3", to: "b1" }, // b3 not cloned → not duplicated
    ];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    cloneSelection();

    expect(s.edges).toHaveLength(4);
    const extra = s.edges[3]!;
    expect([extra.from, extra.to]).not.toContain("b3");
  });

  it("duplicates a self-loop onto the clone", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "a", x: 0, y: 0 }];
    s.edges = [{ from: "b1", to: "b1" }];
    s.selected = new Set(["b1"]);
    wire(s);

    const idMap = cloneSelection();

    expect(s.edges).toHaveLength(2);
    expect(s.edges[1]).toEqual({ from: idMap.get("b1"), to: idMap.get("b1") });
  });

  it("does not duplicate an edge whose endpoint is a cloned TEXT", () => {
    // idMap contains the text's new id too — the rule must check the
    // clone is a box, not merely that the endpoint was cloned.
    const s = makeState();
    s.boxes = [{ id: "b1", label: "a", x: 0, y: 0 }];
    s.texts = [{ id: "t1", label: "note", x: 0, y: 100 }];
    s.edges = [{ from: "b1", to: "t1" }];
    s.selected = new Set(["b1", "t1"]);
    wire(s);

    cloneSelection();

    expect(s.edges).toHaveLength(1);
  });

  it("adds exactly one copy per qualifying edge (never re-walks its own output)", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "a", x: 0, y: 0 },
      { id: "b2", label: "b", x: 100, y: 0 },
    ];
    s.edges = [{ from: "b1", to: "b2" }, { from: "b2", to: "b1" }];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    cloneSelection();
    expect(s.edges).toHaveLength(4);
  });
});

describe("cloneEdgesForIdMap (pure rule)", () => {
  const idMap = new Map([["b1", "n1"], ["b2", "n2"], ["t1", "tn1"]]);
  const boxIds = new Set(["n1", "n2"]);

  it("copies only box↔box edges inside the cloned set", () => {
    const out = cloneEdgesForIdMap(
      [
        { from: "b1", to: "b2" },
        { from: "b1", to: "outside" },
        { from: "b1", to: "t1" },
      ],
      idMap,
      boxIds,
    );
    expect(out).toEqual([{ from: "n1", to: "n2" }]);
  });

  it("does not touch its input", () => {
    const edges = [{ from: "b1", to: "b2", palette: 3 }];
    cloneEdgesForIdMap(edges, idMap, boxIds);
    expect(edges).toEqual([{ from: "b1", to: "b2", palette: 3 }]);
  });
});

describe("selection handover", () => {
  it("replaces the selection with exactly the new ids", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "a", x: 0, y: 0 }];
    s.texts = [{ id: "t1", label: "n", x: 0, y: 0 }];
    s.selected = new Set(["b1", "t1"]);
    wire(s);

    const idMap = cloneSelection();

    // The copies are what the alt-drag goes on to move; keeping the
    // sources selected would drag the originals along.
    expect(s.selected).toEqual(new Set(idMap.values()));
    expect(s.selected.has("b1")).toBe(false);
    expect(s.selected.has("t1")).toBe(false);
  });

  it("silently drops ids that resolve to nothing (strokes are out of scope)", () => {
    // Deliberate per attach.ts: "No ⌥-clone mapping: cloneSelection
    // doesn't cover strokes". A mixed selection clones what it can and
    // the unresolvable id leaves the selection.
    const s = makeState();
    s.boxes = [{ id: "b1", label: "a", x: 0, y: 0 }];
    s.selected = new Set(["b1", "stroke_1", "ghost"]);
    wire(s);

    const idMap = cloneSelection();

    expect(idMap.size).toBe(1);
    expect(s.selected.size).toBe(1);
    expect(s.selected.has("stroke_1")).toBe(false);
    expect(s.boxes).toHaveLength(2);
  });

  it("an empty selection is a no-op returning an empty map", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "a", x: 0, y: 0 }];
    wire(s);

    const idMap = cloneSelection();

    expect(idMap.size).toBe(0);
    expect(s.selected.size).toBe(0);
    expect(s.boxes).toHaveLength(1);
    expect(s.edges).toHaveLength(0);
  });
});

describe("wiring guard", () => {
  it("throws a named error before wireClone() has run", async () => {
    // Module-level bindings persist across tests in this file, so the
    // unwired state needs a fresh module instance.
    vi.resetModules();
    const fresh = await import("./clone.ts");
    expect(() => fresh.cloneSelection()).toThrow(/wireClone/);
  });
});
