import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PASTE_OFFSET_PX,
  copySelection,
  cutSelection,
  pasteSelection,
  wireClipboard,
} from "./clipboard.ts";
import { GRID } from "./movers.ts";
import { wireMutations } from "./mutations.ts";

interface Box {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
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
}
interface Edge {
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
}
interface Img {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Stroke {
  id: string;
  points: Array<[number, number]>;
  palette?: number;
}

interface State {
  boxes: Box[];
  texts: Text[];
  lines: Line[];
  edges: Edge[];
  strokes: Stroke[];
  images: Img[];
  selected: Set<string>;
}

const makeState = (): State => ({
  boxes: [],
  texts: [],
  lines: [],
  edges: [],
  strokes: [],
  images: [],
  selected: new Set(),
});

// Ids handed to renderItems by the last paste — the incremental
// render contract (#24f): a paste must name exactly what it created.
let rendered: string[] = [];

const wire = (s: State): void => {
  let n = 0;
  rendered = [];
  wireMutations({ scheduleSave: () => {} });
  wireClipboard({
    selected: s.selected,
    currentMap: () => ({
      boxes: s.boxes,
      edges: s.edges,
      texts: s.texts,
      lines: s.lines,
      strokes: s.strokes,
      images: s.images,
    }),
    findTextById: (id) => s.texts.find((t) => t.id === id),
    findLineById: (id) => s.lines.find((l) => l.id === id),
    findStrokeById: (id) => s.strokes.find((st) => st.id === id),
    findImageById: (id) => s.images.find((i) => i.id === id),
    mintId: (p) => `${p}_new${++n}`,
    renderItems: (ids) => { rendered = [...ids]; },
    deleteSelection: () => {
      s.boxes = s.boxes.filter((b) => !s.selected.has(b.id));
      s.texts = s.texts.filter((t) => !s.selected.has(t.id));
      s.lines = s.lines.filter((l) => !s.selected.has(l.id));
      s.strokes = s.strokes.filter((st) => !s.selected.has(st.id));
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
      { id: "b1", label: "first", x: 10, y: 20, palette: 5 },
      { id: "b2", label: "second", x: 40, y: 50 },
    ];
    s.edges = [{ from: "b1", to: "b2" }];
    s.selected = new Set(["b1", "b2"]);
    wire(s);

    copySelection();
    s.selected.clear();
    pasteSelection();

    // Two new boxes appended with the one-step cascade and minted ids.
    expect(s.boxes).toHaveLength(4);
    const pastedFirst = s.boxes[2];
    const pastedSecond = s.boxes[3];
    expect(pastedFirst).toMatchObject({ label: "first", x: 70, y: 80 });
    expect(pastedSecond).toMatchObject({ label: "second", x: 100, y: 110 });
    expect(pastedFirst?.id).not.toBe("b1");
    expect(pastedSecond?.id).not.toBe("b2");

    // Edge between the pasted pair is duplicated with the new ids.
    expect(s.edges).toHaveLength(2);
    expect(s.edges[1]).toEqual({ from: pastedFirst?.id, to: pastedSecond?.id });
  });

  it("renders exactly the pasted ids, not the whole map (#24f)", () => {
    const s = makeState();
    // A map with plenty of items the paste must NOT touch.
    for (let i = 0; i < 20; i++) {
      s.boxes.push({ id: "b" + i, label: "n" + i, x: i * 50, y: 0 });
    }
    s.texts.push({ id: "t0", label: "note", x: 0, y: 300 });
    s.lines.push({ id: "l0", x1: 0, y1: 400, x2: 100, y2: 400 });
    s.selected = new Set(["b0", "b1", "t0", "l0"]);
    wire(s);

    copySelection();
    pasteSelection();

    // 4 items pasted → 4 ids rendered, and they are exactly the new
    // selection (which is exactly the pasted set).
    expect(rendered).toHaveLength(4);
    expect(new Set(rendered)).toEqual(new Set(s.selected));
    // None of the untouched originals are in the render set.
    for (const id of ["b0", "b1", "b2", "t0", "l0"]) {
      expect(rendered).not.toContain(id);
    }
  });

  it("adds hexagons the settle pass moved to the render set (#24f)", () => {
    const s = makeState();
    // Hexagons never overlap, and every paste runs the settle repair
    // over the WHOLE map — so a paste can relocate a hexagon it did not
    // create (here: two overlapping hexes that came in from a
    // hand-written file, where nothing has settled them yet). That box
    // has to join the render set or its element keeps the stale
    // position. This is why the settle reports ids, not a boolean.
    s.boxes = [
      { id: "h1", label: "hex", x: 0, y: 0, shape: 1 },
      { id: "h2", label: "hex", x: 10, y: 10, shape: 1 },
      { id: "p", label: "plain", x: 500, y: 500 },
    ];
    s.selected = new Set(["p"]);
    wire(s);
    const before = new Map(s.boxes.map((b) => [b.id, `${b.x},${b.y}`]));

    copySelection();
    pasteSelection();

    const moved = s.boxes.filter(
      (b) => before.has(b.id) && before.get(b.id) !== `${b.x},${b.y}`,
    );
    const pasted = s.boxes.filter((b) => !before.has(b.id));
    // The settle must actually have kicked in, or this asserts nothing.
    expect(moved.map((b) => b.id)).toEqual(["h2"]);
    expect(pasted).toHaveLength(1);
    for (const b of [...moved, ...pasted]) expect(rendered).toContain(b.id);
    expect(rendered).toHaveLength(2);
  });

  it("copies + pastes an image: new id, cascade offset, shared src", () => {
    const s = makeState();
    s.images = [
      { id: "img1", src: "flowgo-media/abc.png", x: 100, y: 100, width: 300, height: 200 },
    ];
    s.selected = new Set(["img1"]);
    wire(s);

    copySelection();
    s.selected.clear();
    pasteSelection();

    expect(s.images).toHaveLength(2);
    const pasted = s.images[1]!;
    expect(pasted.id).not.toBe("img1");
    // src is reused verbatim — the media file is shared, not re-uploaded.
    expect(pasted.src).toBe("flowgo-media/abc.png");
    expect(pasted).toMatchObject({ x: 160, y: 160, width: 300, height: 200 });
    // The pasted image is the new selection.
    expect(s.selected.has(pasted.id)).toBe(true);
    expect(s.selected.has("img1")).toBe(false);
  });
});

// ---------------------------------------------------------------
// Paste cascade (brain#255)
//
// The bug: paste used a 20px step, which is less than half the height
// of a default box (~41 CSS px), so each copy's label landed on top of
// the previous copy's label — a paste-paste-paste looked like one
// smeared node and you could not tell there were three.
// ---------------------------------------------------------------

// A two-map document, so a paste can be aimed at a map other than the
// one the copy came from. `cur` is what the editor's currentMap()
// would return after navigating.
interface MapState {
  path: string;
  boxes: Box[];
  edges: Edge[];
  texts: Text[];
  lines: Line[];
  images: Img[];
}
const makeMap = (path: string): MapState => ({
  path, boxes: [], edges: [], texts: [], lines: [], images: [],
});

const wireMaps = (
  maps: MapState[],
  selected: Set<string>,
  at: () => string,
): void => {
  let n = 0;
  const cur = (): MapState => maps.find((m) => m.path === at())!;
  wireMutations({ scheduleSave: () => {} });
  wireClipboard({
    selected,
    currentMap: () => cur(),
    findTextById: (id) => cur().texts.find((t) => t.id === id),
    findLineById: (id) => cur().lines.find((l) => l.id === id),
    findStrokeById: () => undefined,
    findImageById: (id) => cur().images.find((i) => i.id === id),
    mintId: (p) => `${p}_new${++n}`,
    renderItems: () => {},
    deleteSelection: () => {},
    setStatus: () => {},
    clearSelectedEdge: () => {},
  });
};

describe("paste cascade (#255)", () => {
  it("steps a multiple of the drag grid, far enough to clear a box", () => {
    // Multiple of GRID: a shift-snapped selection is still snapped
    // after a paste. Taller than a default box (41 CSS px measured in
    // Chromium at the 16px label floor): the copy's label can never
    // sit on the source's label, which is the whole point of the card.
    expect(PASTE_OFFSET_PX % GRID).toBe(0);
    expect(PASTE_OFFSET_PX).toBeGreaterThanOrEqual(41);
  });

  it("offsets the first paste and cascades on every repeat", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "one", x: 100, y: 200 }];
    s.selected = new Set(["b1"]);
    wire(s);

    copySelection();
    pasteSelection();
    pasteSelection();
    pasteSelection();

    const k = PASTE_OFFSET_PX;
    // Three copies at three DISTINCT positions — the assertion the bug
    // report is really about ("you can't tell there are three").
    expect(s.boxes.map((b) => `${b.x},${b.y}`)).toEqual([
      "100,200",
      `${100 + k},${200 + k}`,
      `${100 + 2 * k},${200 + 2 * k}`,
      `${100 + 3 * k},${200 + 3 * k}`,
    ]);
    expect(new Set(s.boxes.map((b) => `${b.x},${b.y}`)).size).toBe(4);
  });

  it("a fresh copy restarts the cascade from the new source", () => {
    const s = makeState();
    s.boxes = [{ id: "b1", label: "one", x: 0, y: 0 }];
    s.selected = new Set(["b1"]);
    wire(s);

    copySelection();
    pasteSelection();
    pasteSelection();
    // Paste leaves the copies selected; copying them is a new source,
    // so the next paste is one step from THEM, not from b1.
    const source = s.boxes[2]!;
    expect(source.x).toBe(2 * PASTE_OFFSET_PX);
    copySelection();
    pasteSelection();

    const fresh = s.boxes[3]!;
    expect(fresh.x).toBe(source.x + PASTE_OFFSET_PX);
    expect(fresh.y).toBe(source.y + PASTE_OFFSET_PX);
  });

  it("leaves every pre-existing item where it was (undo stays faithful)", () => {
    // Undo restores a whole-document snapshot taken before the paste.
    // That snapshot only describes the paste correctly if the paste is
    // purely additive — it must not drag the originals along with it.
    const s = makeState();
    s.boxes = [
      { id: "b1", label: "one", x: 10, y: 20 },
      { id: "b2", label: "two", x: 300, y: 20 },
    ];
    s.texts = [{ id: "t1", label: "note", x: 0, y: 400 }];
    s.edges = [{ from: "b1", to: "b2" }];
    s.selected = new Set(["b1", "b2", "t1"]);
    wire(s);
    const before = JSON.stringify([s.boxes, s.texts, s.edges]);

    copySelection();
    pasteSelection();
    pasteSelection();

    expect(JSON.stringify([
      s.boxes.slice(0, 2), s.texts.slice(0, 1), s.edges.slice(0, 1),
    ])).toBe(before);
  });

  it("does not offset a paste into a map the copy did not come from", () => {
    const root = makeMap("/");
    const sub = makeMap("/b1");
    root.boxes = [{ id: "b1", label: "one", x: 10, y: 20 }];
    const selected = new Set<string>(["b1"]);
    let at = "/";
    wireMaps([root, sub], selected, () => at);

    copySelection();
    // Navigate into the submap and paste: nothing there to be confused
    // with, so the copy keeps the coordinates it was copied at.
    at = "/b1";
    pasteSelection();
    expect(sub.boxes).toHaveLength(1);
    expect(sub.boxes[0]).toMatchObject({ x: 10, y: 20 });

    // A SECOND paste into that same map does cascade — otherwise the
    // two copies would stack, which is the bug we came here to fix.
    pasteSelection();
    expect(sub.boxes[1]).toMatchObject({
      x: 10 + PASTE_OFFSET_PX, y: 20 + PASTE_OFFSET_PX,
    });
  });

  it("keeps a per-map cascade so returning to the source map never stacks", () => {
    const root = makeMap("/");
    const sub = makeMap("/b1");
    root.boxes = [{ id: "b1", label: "one", x: 0, y: 0 }];
    const selected = new Set<string>(["b1"]);
    let at = "/";
    wireMaps([root, sub], selected, () => at);

    copySelection();
    pasteSelection();               // root, step 1
    at = "/b1";
    pasteSelection();               // submap, step 0
    at = "/";
    pasteSelection();               // root again — must be step 2

    expect(root.boxes.map((b) => b.x)).toEqual([
      0, PASTE_OFFSET_PX, 2 * PASTE_OFFSET_PX,
    ]);
    expect(new Set(root.boxes.map((b) => b.x)).size).toBe(3);
  });

  it("settles a pasted hexagon onto a free cell, never back onto the source", () => {
    // A hexagon is 240x208, so the cascade step lands the copy well
    // inside the source's footprint. The settle pass repairs that —
    // and it must not repair it by putting the copy back exactly where
    // the original is.
    const s = makeState();
    s.boxes = [{ id: "h1", label: "hex", x: 0, y: 0, shape: 1 }];
    s.selected = new Set(["h1"]);
    wire(s);

    copySelection();
    pasteSelection();
    pasteSelection();

    expect(s.boxes).toHaveLength(3);
    expect(s.boxes[0]).toMatchObject({ x: 0, y: 0 });
    const spots = new Set(s.boxes.map((b) => `${b.x},${b.y}`));
    expect(spots.size).toBe(3);
    for (const b of s.boxes.slice(1)) expect(b.shape).toBe(1);
  });
});

describe("brushed strokes", () => {
  it("copy + paste duplicates a stroke, nudged by the cascade", () => {
    const s = makeState();
    s.strokes = [{ id: "s1", points: [[0, 0], [10, 5], [20, 0]], palette: 3 }];
    s.selected = new Set(["s1"]);
    wire(s);

    expect(copySelection()).toBe(true);
    pasteSelection();

    expect(s.strokes).toHaveLength(2);
    const pasted = s.strokes[1]!;
    expect(pasted.id).toBe("s_new1");
    expect(pasted.palette).toBe(3);
    expect(pasted.points).toEqual([
      [PASTE_OFFSET_PX, PASTE_OFFSET_PX],
      [10 + PASTE_OFFSET_PX, 5 + PASTE_OFFSET_PX],
      [20 + PASTE_OFFSET_PX, PASTE_OFFSET_PX],
    ]);
    // The paste is selected and named to the incremental render.
    expect(s.selected.has("s_new1")).toBe(true);
    expect(rendered).toContain("s_new1");
  });

  it("buffers a snapshot: mutating the original after copy leaves the paste unchanged", () => {
    const s = makeState();
    s.strokes = [{ id: "s1", points: [[0, 0], [10, 10]] }];
    s.selected = new Set(["s1"]);
    wire(s);

    copySelection();
    s.strokes[0]!.points[0]![0] = 999; // warp the live stroke
    pasteSelection();

    expect(s.strokes[1]!.points[0]).toEqual([PASTE_OFFSET_PX, PASTE_OFFSET_PX]);
  });

  it("cut removes the stroke and paste brings it back", () => {
    const s = makeState();
    s.strokes = [{ id: "s1", points: [[5, 5], [15, 15]] }];
    s.selected = new Set(["s1"]);
    wire(s);

    cutSelection();
    expect(s.strokes).toHaveLength(0);

    pasteSelection();
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0]!.points).toEqual([
      [5 + PASTE_OFFSET_PX, 5 + PASTE_OFFSET_PX],
      [15 + PASTE_OFFSET_PX, 15 + PASTE_OFFSET_PX],
    ]);
  });

  it("a stroke-only selection is copyable at all", () => {
    // Regression pin: copySelection used to return false when the
    // selection held no boxes/texts/lines/images, so a brushed line
    // could never enter the clipboard.
    const s = makeState();
    s.strokes = [{ id: "s1", points: [[0, 0], [1, 1]] }];
    s.selected = new Set(["s1"]);
    wire(s);
    expect(copySelection()).toBe(true);
  });

  it("creates the strokes array on a map that has none", () => {
    // A map deserialized from JSON can lack the strokes key entirely
    // (the Go side omits empty slices). currentMap() returns the live
    // map object, so the paste's lazily-created array must stick.
    const map: {
      boxes: Box[]; edges: Edge[]; texts: Text[]; lines: Line[];
      strokes?: Stroke[]; images: Img[];
    } = { boxes: [], edges: [], texts: [], lines: [], images: [] };
    const strokeSource: Stroke[] = [{ id: "s1", points: [[0, 0], [1, 1]] }];
    const selected = new Set<string>(["s1"]);
    let n = 0;
    wireMutations({ scheduleSave: () => {} });
    wireClipboard({
      selected,
      currentMap: () => map,
      findTextById: () => undefined,
      findLineById: () => undefined,
      findStrokeById: (id) => strokeSource.find((st) => st.id === id),
      findImageById: () => undefined,
      mintId: (p) => `${p}_new${++n}`,
      renderItems: () => {},
      deleteSelection: () => {},
      setStatus: () => {},
      clearSelectedEdge: () => {},
    });
    copySelection();
    pasteSelection();
    expect(map.strokes).toHaveLength(1);
  });
});
