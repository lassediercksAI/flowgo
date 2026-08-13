// @vitest-environment jsdom
//
// anchors.ts is the (box, element) → Box2D bridge in front of the pure
// anchor math in src/graph/handle.ts, plus the drop-target handle
// priority rule. What can break here is not the trigonometry (pinned
// in src/graph/handle.test.ts) but the THREADING: x/y from the graph
// box, width/height from the rendered element, shape forwarded, and
// cursor coordinates converted screen→data through the live viewport.
// So the tests below mix a few hand-computed literals (which pin the
// numbers end to end) with oracle comparisons against the pure layer
// (which pin the argument plumbing across every code × shape).
//
// jsdom notes: no layout, so element sizes are defined per instance;
// no document.elementsFromPoint, so pickTargetHandle's stack comes
// from a stub — which is fine, because the pure half of the priority
// rule (handleCodeFromStack) is tested on real elements directly.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boxFor,
  endpointAnchor,
  handleAnchor,
  handleCodeFromStack,
  nearestHandle,
  pickTargetHandle,
} from "./anchors.ts";
import {
  handleAnchor as pureHandleAnchor,
  nearestHandle as pureNearestHandle,
  rectAnchor as pureRectAnchor,
} from "../index.ts";
import { HANDLE_CODES, type HandleCode } from "../graph/handle.ts";
import { viewport } from "./viewport.ts";

// A 100×40 element: deliberately non-square so a width/height swap in
// the bridge cannot cancel out.
const EL = { offsetWidth: 100, offsetHeight: 40 };
const BOX = { x: 10, y: 20 };

// Every shape the wire format knows: rect (undefined and explicit 0),
// hexagon, circle, triangle, and an unknown future value that must
// fall back to rect.
const SHAPES: ReadonlyArray<number | undefined> = [undefined, 0, 1, 2, 3, 7];

beforeEach(() => {
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  document.body.innerHTML = "";
});

afterEach(() => {
  // elementsFromPoint is stubbed per test; jsdom has no native one to
  // restore, so just drop it.
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
});

describe("boxFor", () => {
  it("takes x/y from the graph box and width/height from the element", () => {
    expect(boxFor(EL, BOX)).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  });
});

describe("handleAnchor", () => {
  it("pins the rectangle numbers end to end (ANCHOR_INSET = 3)", () => {
    // Right-edge midpoint: x + w − inset, y + h/2.
    expect(handleAnchor(EL, BOX, "r")).toEqual([107, 40]);
    // Top midpoint: x + w/2, y + inset.
    expect(handleAnchor(EL, BOX, "t")).toEqual([60, 23]);
    // Top-left corner, tucked inside the border radius.
    expect(handleAnchor(EL, BOX, "tl")).toEqual([13, 23]);
  });

  it("forwards the shape: a hexagon's tl sits at the 25% vertex, not the bbox corner", () => {
    // leftX = x + 0.25·w + inset = 10 + 25 + 3.
    expect(handleAnchor(EL, { ...BOX, shape: 1 }, "tl")).toEqual([38, 23]);
    // Rect (no shape) would have said [13, 23] — the drift this pins.
    expect(handleAnchor(EL, BOX, "tl")).not.toEqual(handleAnchor(EL, { ...BOX, shape: 1 }, "tl"));
  });

  it("agrees with the pure layer for every code × shape (argument threading)", () => {
    for (const shape of SHAPES) {
      for (const code of HANDLE_CODES) {
        expect(
          handleAnchor(EL, { ...BOX, shape }, code),
          `code=${code} shape=${String(shape)}`,
        ).toEqual(pureHandleAnchor(boxFor(EL, BOX), code, shape));
      }
    }
  });
});

describe("nearestHandle", () => {
  it("picks the handle nearest the given data point", () => {
    const b = { x: 0, y: 0 }; // with EL: a 100×40 box at the origin
    expect(nearestHandle(b, EL, 200, 20)).toBe("r"); // far right, mid-height
    expect(nearestHandle(b, EL, -5, -5)).toBe("tl");
    expect(nearestHandle(b, EL, 50, 100)).toBe("b");
    expect(nearestHandle(b, EL, 98, 39)).toBe("br");
  });

  it("matches the pure layer across shapes and a spread of points", () => {
    const points: ReadonlyArray<[number, number]> = [
      [0, 0], [110, 40], [60, -50], [10, 60], [500, 500], [-100, 30],
    ];
    for (const shape of SHAPES) {
      for (const [fx, fy] of points) {
        expect(
          nearestHandle({ ...BOX, shape }, EL, fx, fy),
          `(${fx},${fy}) shape=${String(shape)}`,
        ).toBe(pureNearestHandle(boxFor(EL, BOX), [fx, fy], shape));
      }
    }
  });
});

describe("endpointAnchor", () => {
  it("uses a stored handle code verbatim, ignoring the toward-point", () => {
    // toward is far BELOW, but the stored code says top.
    expect(endpointAnchor(BOX, EL, "t", 60, 9999)).toEqual(handleAnchor(EL, BOX, "t"));
  });

  it("falls back to the nearest handle when the code is missing or garbage", () => {
    const towardRight = handleAnchor(EL, BOX, "r");
    for (const code of [null, undefined, "", "zz"]) {
      expect(
        endpointAnchor(BOX, EL, code, 500, 40),
        `code=${String(code)}`,
      ).toEqual(towardRight);
    }
  });

  it("is shape-aware in both branches (hexagon vertices)", () => {
    const hex = { ...BOX, shape: 1 };
    expect(endpointAnchor(hex, EL, "tl", 0, 0)).toEqual([38, 23]);
    expect(endpointAnchor(hex, EL, null, -100, -100)).toEqual(
      pureRectAnchor(boxFor(EL, hex), null, [-100, -100], 1),
    );
  });
});

// ── handle priority: the pure stack scan ───────────────────────────

const makeHandle = (parent: HTMLElement, code?: string): HTMLElement => {
  const h = document.createElement("div");
  h.className = "handle";
  if (code !== undefined) h.dataset["handle"] = code;
  parent.appendChild(h);
  return h;
};

const makeBoxEl = (): HTMLElement => {
  const el = document.createElement("div");
  el.className = "box";
  document.body.appendChild(el);
  return el;
};

describe("handleCodeFromStack", () => {
  it("returns the code of a handle dot that belongs to the target", () => {
    const target = makeBoxEl();
    const h = makeHandle(target, "tr");
    expect(handleCodeFromStack([h], target)).toBe("tr");
  });

  it("refuses a handle that belongs to ANOTHER box — a neighbour's dot must not hijack the drop", () => {
    const target = makeBoxEl();
    const other = makeBoxEl();
    const foreign = makeHandle(other, "tl");
    expect(handleCodeFromStack([foreign], target)).toBeNull();
  });

  it("skips non-handle elements and codeless handles, taking the first usable hit", () => {
    const target = makeBoxEl();
    const plain = document.createElement("div"); // e.g. the box label
    target.appendChild(plain);
    const codeless = makeHandle(target); // no data-handle attribute
    const good = makeHandle(target, "bl");
    const later = makeHandle(target, "r");
    // Stack order is top-most first; the first usable entry wins.
    expect(handleCodeFromStack([plain, codeless, good, later], target)).toBe("bl");
  });

  it("returns null for an empty stack", () => {
    expect(handleCodeFromStack([], makeBoxEl())).toBeNull();
  });
});

// ── pickTargetHandle: DOM hit first, cursor geometry second ────────

// Give the target element a measurable size; jsdom reports 0.
const sizedBoxEl = (w: number, h: number): HTMLElement => {
  const el = makeBoxEl();
  Object.defineProperty(el, "offsetWidth", { value: w, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: h, configurable: true });
  return el;
};

const stubStack = (stack: Element[]): { calls: Array<[number, number]> } => {
  const calls: Array<[number, number]> = [];
  (document as unknown as {
    elementsFromPoint: (x: number, y: number) => Element[];
  }).elementsFromPoint = (x, y) => {
    calls.push([x, y]);
    return stack;
  };
  return { calls };
};

describe("pickTargetHandle", () => {
  it("a handle dot under the cursor wins outright, even against the geometry", () => {
    const target = sizedBoxEl(100, 40);
    const h = makeHandle(target, "bl");
    const { calls } = stubStack([h]);
    // Cursor at the box's top-right — geometry would say tr/r.
    expect(pickTargetHandle(target, { x: 0, y: 0 }, 99, 1)).toBe("bl");
    // The hit test ran at the cursor, not somewhere derived.
    expect(calls).toEqual([[99, 1]]);
  });

  it("falls back to the handle nearest the CURSOR when nothing direct is hit", () => {
    const target = sizedBoxEl(100, 40);
    stubStack([]);
    expect(pickTargetHandle(target, { x: 0, y: 0 }, 200, 20)).toBe("r");
    expect(pickTargetHandle(target, { x: 0, y: 0 }, -10, -10)).toBe("tl");
  });

  it("a foreign box's handle in the stack falls through to geometry", () => {
    const target = sizedBoxEl(100, 40);
    const other = makeBoxEl();
    stubStack([makeHandle(other, "tl")]);
    expect(pickTargetHandle(target, { x: 0, y: 0 }, 200, 20)).toBe("r");
  });

  it("converts the cursor screen→data through the live viewport for the fallback", () => {
    // Zoomed 2×, panned (100, 50). Client (290, 90) ⇔ data (95, 20):
    // right-edge midpoint ⇒ "r". Feeding client px straight into the
    // geometry would pick "br" instead (the point is far below-right
    // in screen numbers) — that asymmetry is what makes this a test.
    viewport.s = 2;
    viewport.x = 100;
    viewport.y = 50;
    const target = sizedBoxEl(100, 40);
    stubStack([]);
    expect(pickTargetHandle(target, { x: 0, y: 0 }, 290, 90)).toBe("r");
  });

  it("respects the target's shape in the geometry fallback", () => {
    const target = sizedBoxEl(100, 40);
    stubStack([]);
    // Directly above the bbox's top-left corner. A hexagon's tl vertex
    // is inset to 25% width, so tl and t both move toward the centre;
    // the pure layer is the oracle for which wins.
    const want = pureNearestHandle({ x: 0, y: 0, width: 100, height: 40 }, [0, -10], 1);
    expect(pickTargetHandle(target, { x: 0, y: 0, shape: 1 }, 0, -10)).toBe(want);
  });
});
