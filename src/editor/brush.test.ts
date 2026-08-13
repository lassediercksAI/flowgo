// @vitest-environment jsdom
//
// Brush mode (src/editor/brush.ts): free-hand stroke capture through
// the real start/extend/finish/abandon lifecycle, with the REAL
// simplifyStroke (graph/stroke.ts) and mutations chokepoint wired in —
// so "what lands in map.strokes" is the actual production pipeline,
// not a mock of it.
//
// Module-level state (brushMode, palette, the in-flight stroke)
// persists across tests. Resets go through the real lifecycle paths:
// abandonStroke() for a leftover in-flight stroke, setBrushMode(false),
// setBrushPalette(1). (abandonStroke was added for the pinch takeover,
// brain#24c — see touch-pinch.test.ts for the gesture-level side.)
//
// Commit-vs-abandon asymmetry, pinned at this module's seam: iOS
// touchcancel routes to finishStroke() (touch.ts) because an
// interrupted-but-intentional stroke should keep what it drew, while a
// pinch takeover routes to abandonStroke(). The event routing itself
// lives in touch.ts (covered by touch-pinch.test.ts); here we pin that
// the two exits genuinely differ on identical input.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  abandonStroke,
  cursorForPalette,
  extendStroke,
  finishStroke,
  getBrushPalette,
  isBrushMode,
  isPainting,
  passesMinDistance,
  previewPoints,
  setBrushMode,
  setBrushPalette,
  startStroke,
  wireBrush,
} from "./brush.ts";
import { wireMutations } from "./mutations.ts";
import { viewport } from "./viewport.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface StrokeRec {
  id: string;
  points: Array<readonly [number, number]>;
  palette?: number;
}
// `strokes` optional on purpose: finishStroke must create the array
// on a map that has never had a stroke (`m.strokes ??= []`).
const map: { strokes?: StrokeRec[] } = { strokes: [] };

let strokeLayer: SVGGElement;
let mintN = 0;
const commits: Array<string | null> = [];
const statuses: string[] = [];
let saves = 0;

beforeAll(() => {
  const svg = document.createElementNS(SVG_NS, "svg");
  document.body.appendChild(svg);
  strokeLayer = document.createElementNS(SVG_NS, "g");
  svg.appendChild(strokeLayer);
  wireBrush({
    mintId: () => `s${++mintN}`,
    strokeLayer: () => strokeLayer,
    currentMap: () => map as never,
    afterCommit: (id) => commits.push(id),
    setStatus: (s) => statuses.push(s),
  });
  wireMutations({ scheduleSave: () => saves++ });
});

beforeEach(() => {
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  // Real-lifecycle reset (see header): no synthetic state poking.
  abandonStroke();
  setBrushMode(false);
  setBrushPalette(1);
  map.strokes = [];
  mintN = 0;
  commits.length = 0;
  statuses.length = 0;
  saves = 0;
});

afterEach(() => {
  // A test must not leak an in-flight stroke or a stray preview group
  // into the next one.
  abandonStroke();
  expect(strokeLayer.querySelectorAll(".stroke-group")).toHaveLength(0);
});

const groups = (): NodeListOf<SVGGElement> =>
  strokeLayer.querySelectorAll<SVGGElement>("g.stroke-group");
const poly = (): SVGPolylineElement | null =>
  strokeLayer.querySelector<SVGPolylineElement>("polyline.stroke-line");

describe("mode lifecycle", () => {
  it("toggles the body class and announces the mode", () => {
    setBrushMode(true);
    expect(isBrushMode()).toBe(true);
    expect(document.body.classList.contains("brush-mode")).toBe(true);
    expect(statuses).toEqual(["brush mode — drag to paint, V to exit"]);
    setBrushMode(false);
    expect(isBrushMode()).toBe(false);
    expect(document.body.classList.contains("brush-mode")).toBe(false);
    expect(statuses[1]).toBe("select mode");
  });

  it("setting the same mode again is a no-op (no duplicate status)", () => {
    setBrushMode(true);
    setBrushMode(true);
    expect(statuses).toHaveLength(1);
  });
});

describe("startStroke", () => {
  it("opens a live preview group with the first point in data coords", () => {
    expect(isPainting()).toBe(false);
    startStroke(40, 60);
    expect(isPainting()).toBe(true);
    const g = groups();
    expect(g).toHaveLength(1);
    expect(g[0]!.getAttribute("class")).toBe("stroke-group");
    expect(g[0]!.dataset["id"]).toBe("s1");
    expect(poly()!.getAttribute("points")).toBe("40,60");
    // Nothing is in the map yet — commit happens at finish.
    expect(map.strokes).toHaveLength(0);
  });

  it("converts client → data through the viewport, rounded to 2 decimals", () => {
    viewport.x = 100;
    viewport.y = 50;
    viewport.s = 3;
    startStroke(110, 60); // (10/3, 10/3) → 3.33
    expect(poly()!.getAttribute("points")).toBe("3.33,3.33");
    abandonStroke();
  });

  it("tags the preview group with the palette class for palettes 2..9", () => {
    setBrushPalette(3);
    startStroke(0, 0);
    expect(groups()[0]!.getAttribute("class")).toBe("stroke-group palette-3");
    abandonStroke();
  });
});

describe("extendStroke — min-distance filtering", () => {
  it("is a no-op when no stroke is in flight", () => {
    extendStroke(50, 50); // must not throw
    expect(isPainting()).toBe(false);
  });

  it("appends points 2+ data units apart and updates the preview", () => {
    startStroke(0, 0);
    extendStroke(10, 0);
    extendStroke(10, 10);
    expect(poly()!.getAttribute("points")).toBe("0,0 10,0 10,10");
  });

  it("drops hand-jitter samples under 2 data units from the LAST KEPT point", () => {
    startStroke(0, 0);
    extendStroke(1, 1); // 1.41 < 2 — dropped
    extendStroke(1.5, 0); // still measured from (0,0), dropped
    expect(poly()!.getAttribute("points")).toBe("0,0");
    extendStroke(2, 0); // exactly 2 — kept (boundary)
    expect(poly()!.getAttribute("points")).toBe("0,0 2,0");
    extendStroke(3.9, 0); // 1.9 from (2,0) — dropped
    expect(poly()!.getAttribute("points")).toBe("0,0 2,0");
  });

  it("measures the threshold in DATA units, so zoom changes the client-px gate", () => {
    viewport.s = 4;
    startStroke(0, 0);
    extendStroke(4, 0); // 4 client px = 1 data unit < 2 — dropped
    expect(poly()!.getAttribute("points")).toBe("0,0");
    extendStroke(8, 0); // 8 client px = 2 data units — kept
    expect(poly()!.getAttribute("points")).toBe("0,0 2,0");
  });
});

describe("finishStroke — commit", () => {
  it("commits the simplified points to the map and reports the id", () => {
    startStroke(0, 0);
    extendStroke(100, 0);
    finishStroke();
    expect(isPainting()).toBe(false);
    expect(map.strokes).toEqual([{ id: "s1", points: [[0, 0], [100, 0]] }]);
    expect(commits).toEqual(["s1"]);
    // A committed stroke IS a document change — exactly one save.
    expect(saves).toBe(1);
    // The throwaway preview group is removed; the renderer (not this
    // module) builds the real stroke group from state afterwards.
    expect(groups()).toHaveLength(0);
  });

  it("drops tremor points within ε≈1.5 of the chord (real simplifyStroke)", () => {
    startStroke(0, 0);
    extendStroke(50, 1); // 1 unit off the (0,0)–(100,0) chord → simplified away
    extendStroke(100, 0);
    finishStroke();
    expect(map.strokes![0]!.points).toEqual([[0, 0], [100, 0]]);
  });

  it("keeps an intentional bend beyond ε", () => {
    startStroke(0, 0);
    extendStroke(50, 10); // 10 units off the chord → a real corner
    extendStroke(100, 0);
    finishStroke();
    expect(map.strokes![0]!.points).toEqual([[0, 0], [50, 10], [100, 0]]);
  });

  it("persists the palette only when it is a real override (2..9)", () => {
    setBrushPalette(2); // 2 is the lowest persisted value — pins >= 2
    startStroke(0, 0);
    extendStroke(50, 0);
    finishStroke();
    expect(map.strokes![0]!.palette).toBe(2);

    setBrushPalette(1);
    startStroke(0, 100);
    extendStroke(50, 100);
    finishStroke();
    // Default palette is represented by absence on the wire.
    expect("palette" in map.strokes![1]!).toBe(false);
  });

  it("the palette is captured at startStroke, not at finish", () => {
    setBrushPalette(5);
    startStroke(0, 0);
    setBrushPalette(9); // user picks a new colour mid-stroke
    extendStroke(50, 0);
    finishStroke();
    expect(map.strokes![0]!.palette).toBe(5);
  });

  it("creates the strokes array on a map that never had one", () => {
    delete map.strokes;
    startStroke(0, 0);
    extendStroke(50, 0);
    finishStroke();
    expect(map.strokes).toEqual([{ id: "s1", points: [[0, 0], [50, 0]] }]);
  });

  it("is a no-op with no stroke in flight — no commit callback, no save", () => {
    finishStroke();
    expect(commits).toEqual([]);
    expect(saves).toBe(0);
  });
});

describe("degenerate strokes never land in the graph", () => {
  it("a zero-movement tap: afterCommit(null), no map entry, no save", () => {
    startStroke(100, 100);
    finishStroke();
    expect(map.strokes).toHaveLength(0);
    // afterCommit still fires (the caller re-renders / clears state),
    // but with null — "nothing was added".
    expect(commits).toEqual([null]);
    // A dropped stroke is not a document change.
    expect(saves).toBe(0);
    expect(groups()).toHaveLength(0);
  });

  it("a wiggle entirely under the jitter threshold is a single point → dropped", () => {
    startStroke(100, 100);
    extendStroke(101, 100);
    extendStroke(100, 101);
    extendStroke(101, 101);
    finishStroke();
    expect(map.strokes).toHaveLength(0);
    expect(commits).toEqual([null]);
    expect(saves).toBe(0);
  });
});

describe("abandonStroke vs finishStroke (the deliberate asymmetry)", () => {
  it("abandon discards everything: no map entry, no callback, no save", () => {
    startStroke(0, 0);
    extendStroke(60, 60); // would be a perfectly committable stroke…
    abandonStroke();
    expect(isPainting()).toBe(false);
    expect(map.strokes).toHaveLength(0);
    expect(commits).toEqual([]); // finish's afterCommit(null) does NOT fire
    expect(saves).toBe(0);
    expect(groups()).toHaveLength(0); // preview removed, not orphaned
  });

  it("identical input, different exits: finish commits, abandon does not", () => {
    startStroke(0, 0);
    extendStroke(60, 60);
    finishStroke(); // the touchcancel path keeps the drawing
    expect(map.strokes).toHaveLength(1);

    startStroke(0, 0);
    extendStroke(60, 60);
    abandonStroke(); // the pinch-takeover path throws it away
    expect(map.strokes).toHaveLength(1);
  });

  it("is a no-op with no stroke in flight", () => {
    abandonStroke(); // must not throw
    expect(isPainting()).toBe(false);
  });
});

describe("palette + dynamic cursor", () => {
  it("defaults to 1 and rejects out-of-range values", () => {
    expect(getBrushPalette()).toBe(1);
    setBrushPalette(7);
    expect(getBrushPalette()).toBe(7);
    setBrushPalette(0);
    setBrushPalette(10);
    expect(getBrushPalette()).toBe(7);
  });

  it("injects a cursor override in brush mode for palettes 2..9 only", () => {
    setBrushMode(true);
    setBrushPalette(4);
    const style = document.getElementById("brush-cursor-dynamic")!;
    expect(style).not.toBeNull();
    expect(style.textContent).toContain("body.brush-mode");
    expect(style.textContent).toContain(cursorForPalette(4));
    // Back to the default palette → override emptied, static grey rules win.
    setBrushPalette(1);
    expect(style.textContent).toBe("");
  });

  it("applies a palette chosen before entering brush mode", () => {
    setBrushPalette(6);
    setBrushMode(true);
    const style = document.getElementById("brush-cursor-dynamic")!;
    expect(style.textContent).toContain(cursorForPalette(6));
  });
});

describe("pure helpers", () => {
  it("previewPoints formats space-separated x,y pairs", () => {
    expect(previewPoints([])).toBe("");
    expect(previewPoints([[1, 2]])).toBe("1,2");
    expect(previewPoints([[1, 2], [3.5, 4]])).toBe("1,2 3.5,4");
  });

  it("passesMinDistance: 2 data units and beyond passes", () => {
    expect(passesMinDistance([0, 0], 1.9, 0)).toBe(false);
    expect(passesMinDistance([0, 0], 2, 0)).toBe(true);
    expect(passesMinDistance([10, 10], 11, 11)).toBe(false);
  });

  it("cursorForPalette embeds the palette body colour, %23-escaped", () => {
    const c = cursorForPalette(4); // green family, body #15803d
    expect(c).toContain("data:image/svg+xml");
    expect(c).toContain("%2315803d");
    expect(c).not.toContain("#15803d"); // every # in the URI must be escaped
    expect(c.endsWith(", crosshair")).toBe(true); // fallback cursor
    // Unknown palette falls back to the default (palette-1) body colour.
    expect(cursorForPalette(42)).toContain("%23333");
  });
});
