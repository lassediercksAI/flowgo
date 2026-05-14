import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copySelection,
  cutSelection,
  pasteSelection,
  wireClipboard,
} from "./clipboard.ts";

interface Box {
  id: string;
  label: string;
  x: number;
  y: number;
  sides?: number;
  palette?: number;
  font?: number;
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
}
interface Edge {
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
}

interface State {
  boxes: Box[];
  texts: Text[];
  lines: Line[];
  edges: Edge[];
  selected: Set<string>;
}

const makeState = (): State => ({
  boxes: [],
  texts: [],
  lines: [],
  edges: [],
  selected: new Set(),
});

const wire = (s: State): void => {
  let n = 0;
  wireClipboard({
    selected: s.selected,
    currentMap: () => ({
      boxes: s.boxes,
      edges: s.edges,
      texts: s.texts,
      lines: s.lines,
    }),
    findTextById: (id) => s.texts.find((t) => t.id === id),
    findLineById: (id) => s.lines.find((l) => l.id === id),
    mintId: (p) => `${p}_new${++n}`,
    scheduleSave: () => {},
    renderAll: () => {},
    deleteSelection: () => {
      s.boxes = s.boxes.filter((b) => !s.selected.has(b.id));
      s.texts = s.texts.filter((t) => !s.selected.has(t.id));
      s.lines = s.lines.filter((l) => !s.selected.has(l.id));
      s.selected.clear();
    },
    setStatus: () => {},
    clearSelectedEdge: () => {},
  });
};

let writeText: ReturnType<typeof vi.fn>;

const installNavigator = (): void => {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText } },
    configurable: true,
    writable: true,
  });
};

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  installNavigator();
});

afterEach(() => {
  // Use defineProperty rather than `delete`: Node ships a non-configurable
  // `navigator` global on some versions, and we always reinstall in beforeEach.
  Object.defineProperty(globalThis, "navigator", {
    value: undefined,
    configurable: true,
    writable: true,
  });
});

describe("copySelection — system clipboard mirror", () => {
  it("writes labels joined by newline", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "alpha", x: 0, y: 0 },
      { id: "b2", label: "beta", x: 0, y: 100 },
    ];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    expect(copySelection()).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("alpha\nbeta");
  });

  it("orders labels top-to-bottom then left-to-right", () => {
    const s = makeState();
    // Arrange three boxes deliberately out of reading order in the array:
    //   gamma at (50, 200) — bottom row
    //   alpha at (100, 50) — top row, right
    //   beta  at   (0, 50) — top row, left
    s.boxes = [
      { id: "g", label: "gamma", x: 50, y: 200 },
      { id: "a", label: "alpha", x: 100, y: 50 },
      { id: "b", label: "beta", x: 0, y: 50 },
    ];
    s.selected = new Set(["g", "a", "b"]);
    wire(s);

    copySelection();
    expect(writeText).toHaveBeenCalledWith("beta\nalpha\ngamma");
  });

  it("includes text items alongside boxes", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "box-label", x: 0, y: 0 }];
    s.texts = [{ id: "t1", label: "text-label", x: 0, y: 100 }];
    s.selected = new Set(["b1", "t1"]);
    wire(s);

    copySelection();
    expect(writeText).toHaveBeenCalledWith("box-label\ntext-label");
  });

  it("preserves empty labels so structure is not lost", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "", x: 0, y: 0 },
      { id: "b2", label: "second", x: 0, y: 100 },
    ];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    copySelection();
    expect(writeText).toHaveBeenCalledWith("\nsecond");
  });

  it("does not write when only lines (no labels) are selected", () => {
    const s = makeState();
    s.lines = [{ id: "l1", x1: 0, y1: 0, x2: 50, y2: 50 }];
    s.selected = new Set(["l1"]);
    wire(s);

    expect(copySelection()).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not write when nothing is selected", () => {
    const s = makeState();
    wire(s);

    expect(copySelection()).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("swallows clipboard write rejection without breaking internal copy", async () => {
    writeText.mockRejectedValueOnce(new Error("permission denied"));
    const s = makeState();
    s.boxes = [{ id: "b1", label: "x", x: 0, y: 0 }];
    s.selected = new Set(["b1"]);
    wire(s);

    expect(copySelection()).toBe(true);
    // Let the rejected promise's .catch run before asserting paste still works.
    await Promise.resolve();
    await Promise.resolve();

    s.selected.clear();
    pasteSelection();
    expect(s.boxes).toHaveLength(2);
    expect(s.boxes[1]?.label).toBe("x");
  });

  it("works when navigator is unavailable", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const s = makeState();
    s.boxes = [{ id: "b1", label: "x", x: 0, y: 0 }];
    s.selected = new Set(["b1"]);
    wire(s);

    expect(() => copySelection()).not.toThrow();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("cut also mirrors to the system clipboard", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "snip", x: 0, y: 0 }];
    s.selected = new Set(["b1"]);
    wire(s);

    cutSelection();
    expect(writeText).toHaveBeenCalledWith("snip");
    expect(s.boxes).toHaveLength(0);
  });
});

describe("copy/paste round-trip preserves in-app structure", () => {
  it("paste uses the in-memory buffer (not the OS clipboard text)", () => {
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "first", x: 10, y: 20, sides: 6 },
      { id: "b2", label: "second", x: 40, y: 50 },
    ];
    s.edges = [{ from: "b1", to: "b2" }];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    copySelection();
    s.selected.clear();
    pasteSelection();

    // Two new boxes appended with the 20px cascade and minted ids.
    expect(s.boxes).toHaveLength(4);
    const pastedFirst = s.boxes[2];
    const pastedSecond = s.boxes[3];
    expect(pastedFirst).toMatchObject({ label: "first", x: 30, y: 40, sides: 6 });
    expect(pastedSecond).toMatchObject({ label: "second", x: 60, y: 70 });
    expect(pastedFirst?.id).not.toBe("b1");
    expect(pastedSecond?.id).not.toBe("b2");

    // Edge between the pasted pair is duplicated with the new ids.
    expect(s.edges).toHaveLength(2);
    expect(s.edges[1]).toEqual({ from: pastedFirst?.id, to: pastedSecond?.id });
  });
});
