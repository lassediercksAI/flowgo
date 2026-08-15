// @vitest-environment jsdom
//
// The pure alignment maths below needs no DOM; the activation suite at
// the bottom (brain#2e5) does, and jsdom is cheap enough that one
// environment for the file beats splitting it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { wireMutations } from "./mutations.ts";
import {
  attachAlignToolbar,
  wireAlign,
  alignItems,
  anyOverlapAlongX,
  anyOverlapAlongY,
  SPREAD_GAP,
  type AlignItem,
} from "./align.ts";

// Minimal AlignItem factory: tests need to construct items with
// arbitrary positions/sizes and read back the same refs after
// alignItems() mutates them in place. The id is only carried so
// applyAlign can hand it to renderItems — the pure math ignores it.
let seq = 0;
const item = (
  x: number,
  y: number,
  width = 100,
  height = 40,
): AlignItem => ({ id: "i" + seq++, ref: { x, y }, width, height });

describe("anyOverlapAlongX", () => {
  it("returns false when items have disjoint X ranges", () => {
    expect(anyOverlapAlongX([item(0, 0), item(200, 0)])).toBe(false);
  });

  it("returns true when two items share any X range", () => {
    // First spans 0-100, second spans 80-180 → overlap 80-100.
    expect(anyOverlapAlongX([item(0, 0), item(80, 0)])).toBe(true);
  });

  it("returns true when two items share the same X (vertical stack)", () => {
    expect(anyOverlapAlongX([item(50, 0), item(50, 200)])).toBe(true);
  });

  it("treats touching edges as non-overlapping", () => {
    // First ends exactly where second begins.
    expect(anyOverlapAlongX([item(0, 0, 100), item(100, 0, 100)])).toBe(false);
  });
});

describe("anyOverlapAlongY", () => {
  it("mirrors anyOverlapAlongX on the Y axis", () => {
    expect(anyOverlapAlongY([item(0, 0), item(0, 200)])).toBe(false);
    expect(anyOverlapAlongY([item(0, 0), item(0, 30)])).toBe(true);
    expect(anyOverlapAlongY([item(0, 0, 100, 40), item(0, 40, 100, 40)])).toBe(false);
  });
});

describe("alignItems — guard", () => {
  it("returns false for < 2 items without mutating", () => {
    const a = item(10, 20);
    expect(alignItems([a], "horizontal")).toBe(false);
    expect(a.ref).toEqual({ x: 10, y: 20 });
    expect(alignItems([], "vertical")).toBe(false);
  });
});

describe("alignItems — horizontal axis (match Y centres)", () => {
  it("snaps every item's Y centre to the mean Y centre", () => {
    // Two same-height items at y=0 and y=100 → mean centre y=70,
    // so each item should sit at y=50 (centre 70 - 20 half-height).
    const a = item(0,   0, 100, 40);
    const b = item(200, 100, 100, 40);
    alignItems([a, b], "horizontal");
    expect(a.ref.y).toBe(50);
    expect(b.ref.y).toBe(50);
    expect(a.ref.x).toBe(0);   // X untouched — they didn't overlap.
    expect(b.ref.x).toBe(200);
  });

  it("preserves X when items already had disjoint X ranges", () => {
    const a = item(0,   30);
    const b = item(150, 60);
    const c = item(300, 90);
    alignItems([a, b, c], "horizontal");
    // Mean centre y of three items at y=30,60,90 (h=40) is 80 → y=60.
    expect([a.ref.y, b.ref.y, c.ref.y]).toEqual([60, 60, 60]);
    expect([a.ref.x, b.ref.x, c.ref.x]).toEqual([0, 150, 300]);
  });

  it("spreads vertically-stacked items along X with SPREAD_GAP", () => {
    // Three items, all at the same X (vertical stack). After
    // horizontal alignment they'd pile on top of each other.
    const top    = item(50, 0,   100, 40);
    const middle = item(50, 100, 100, 40);
    const bot    = item(50, 200, 100, 40);
    alignItems([top, middle, bot], "horizontal");
    // All share the same Y centre now.
    expect(top.ref.y).toBe(top.ref.y);
    expect(middle.ref.y).toBe(top.ref.y);
    expect(bot.ref.y).toBe(top.ref.y);
    // Spread starts at the leftmost X (50) and walks
    // right-to-left in original-top-to-bottom order, with the
    // standard gap between widths.
    expect(top.ref.x).toBe(50);
    expect(middle.ref.x).toBe(50 + 100 + SPREAD_GAP);
    expect(bot.ref.x).toBe(50 + 100 + SPREAD_GAP + 100 + SPREAD_GAP);
    // And after spreading they no longer overlap.
    expect(anyOverlapAlongX([top, middle, bot])).toBe(false);
  });

  it("spreads items whose X ranges merely overlap (not just identical)", () => {
    const a = item(0,  0,   100, 40);
    const b = item(80, 200, 100, 40); // overlaps a on X (0-100 vs 80-180)
    alignItems([a, b], "horizontal");
    expect(a.ref.x).toBe(0);
    expect(b.ref.x).toBe(0 + 100 + SPREAD_GAP); // = 120
    expect(anyOverlapAlongX([a, b])).toBe(false);
  });

  it("respects item-size differences when spreading", () => {
    const skinny = item(0, 0,  50, 40);
    const wide   = item(0, 50, 200, 40);
    alignItems([skinny, wide], "horizontal");
    expect(skinny.ref.x).toBe(0);
    expect(wide.ref.x).toBe(0 + 50 + SPREAD_GAP); // 70
  });
});

describe("alignItems — vertical axis (match X centres)", () => {
  it("snaps every item's X centre to the mean X centre", () => {
    const a = item(0,   0, 100, 40);
    const b = item(200, 100, 100, 40);
    alignItems([a, b], "vertical");
    // Mean centre x = (50 + 250) / 2 = 150 → each item at x=100.
    expect(a.ref.x).toBe(100);
    expect(b.ref.x).toBe(100);
    // Y untouched.
    expect(a.ref.y).toBe(0);
    expect(b.ref.y).toBe(100);
  });

  it("spreads horizontally-stacked items along Y with SPREAD_GAP", () => {
    const left   = item(0,   50, 100, 40);
    const middle = item(150, 50, 100, 40);
    const right  = item(300, 50, 100, 40);
    alignItems([left, middle, right], "vertical");
    // After alignment all share an X; check Y spread.
    expect(left.ref.x).toBe(middle.ref.x);
    expect(middle.ref.x).toBe(right.ref.x);
    expect(left.ref.y).toBe(50);
    expect(middle.ref.y).toBe(50 + 40 + SPREAD_GAP);
    expect(right.ref.y).toBe(50 + 40 + SPREAD_GAP + 40 + SPREAD_GAP);
    expect(anyOverlapAlongY([left, middle, right])).toBe(false);
  });
});

// ---------------------------------------------------------------
// Activation (brain#2e5)
//
// WHAT THESE PROVE: the MECHANISM. #alignToolbar's buttons activate on
// `pointerup`, so they still work when no `click` ever arrives, and a
// click that DOES arrive right after a pointerup is recognised as that
// tap's own echo instead of aligning a second time.
//
// WHAT THEY DO NOT PROVE: that an iPad now aligns. jsdom does not
// synthesize clicks from touches, and no headless engine reproduces
// iOS Safari's click-synthesis rules. The chain of reasoning is the
// one brain#256/#257/#294 established and verified in a real browser
// by suppressing the synthetic click (#helpBtn / #zoomCtl survived,
// #upBtn — the last bare-`click` control — died): under the
// document-level {passive:false} touch listeners in touch.ts, iOS may
// not deliver the click, and #alignToolbar had no other path in. The
// device half is still outstanding.

describe("attachAlignToolbar — activation", () => {
  // Two boxes, 200px apart vertically, so a horizontal align has a
  // visible effect and alignItems() returns true (2+ alignable items).
  interface Box { id: string; x: number; y: number }
  let boxes: Box[];
  let rendered: string[][];
  let canvas: HTMLElement;

  const buttons = (): HTMLButtonElement[] =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("#alignToolbar button"));

  const dispatch = (el: Element, type: string): Event => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    canvas = document.createElement("div");
    canvas.id = "canvas";
    document.body.appendChild(canvas);
    boxes = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0, y: 200 },
    ];
    rendered = [];
    const el = (): HTMLElement => {
      const d = document.createElement("div");
      Object.defineProperty(d, "offsetWidth", { value: 100 });
      Object.defineProperty(d, "offsetHeight", { value: 40 });
      return d;
    };
    wireMutations({ scheduleSave: () => {} });
    wireAlign({
      canvas,
      currentMap: () => ({ boxes, texts: [] }),
      selected: new Set(["a", "b"]),
      getBoxEl: () => el(),
      getTextEl: () => null,
      renderItems: (ids) => { rendered.push([...ids]); },
    });
    attachAlignToolbar();
  });

  it("builds two buttons inside #canvas", () => {
    expect(buttons()).toHaveLength(2);
    expect(document.getElementById("alignToolbar")?.parentElement).toBe(canvas);
  });

  it("aligns on pointerup alone — no click required (the iOS path)", () => {
    // This is the whole point: on iOS Safari the synthesized click may
    // never arrive, and until brain#2e5 `click` was this toolbar's ONLY
    // listener, so nothing happened at all.
    dispatch(buttons()[0]!, "pointerup");
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.sort()).toEqual(["a", "b"]);
    // Horizontal align matches Y centres: both boxes end up at the mean.
    expect(boxes[0]!.y).toBe(boxes[1]!.y);
  });

  it("aligns on click alone — the keyboard path (Enter/Space fire no pointerup)", () => {
    dispatch(buttons()[1]!, "click");
    expect(rendered).toHaveLength(1);
    // Vertical align matches X centres; both start at x=0 so the
    // observable effect is the spread, not the x. Assert the call.
    expect(rendered[0]!.sort()).toEqual(["a", "b"]);
  });

  it("a pointerup followed by its synthetic click aligns exactly ONCE", () => {
    // Desktop and Chromium-on-touch both deliver pointerup AND click
    // for one press. Without the echo guard that is two aligns and two
    // undo steps for one tap.
    const btn = buttons()[0]!;
    dispatch(btn, "pointerup");
    dispatch(btn, "click");
    expect(rendered).toHaveLength(1);
  });

  it("swallows the echo click even when the very first press is at t≈0", () => {
    // brain#257's latch bug: a `let last = 0` sentinel makes every
    // activation in the first half-second of page life look like an
    // echo — or, mirrored, makes the first echo look fresh. The
    // sentinel here is -Infinity, and this test runs at whatever
    // performance.now() vitest is at, first press included.
    const btn = buttons()[1]!;
    dispatch(btn, "pointerup");
    dispatch(btn, "click");
    expect(rendered).toHaveLength(1);
  });

  it("both events preventDefault and stopPropagation so the canvas never sees them", () => {
    // #alignToolbar is parked INSIDE #canvas (the viewport transform
    // carries it), so an unstopped event reaches the canvas listeners
    // and clears the very selection the toolbar is acting on.
    const btn = buttons()[0]!;
    let leaked = 0;
    canvas.addEventListener("pointerup", () => { leaked++; });
    canvas.addEventListener("click", () => { leaked++; });
    expect(dispatch(btn, "pointerup").defaultPrevented).toBe(true);
    expect(dispatch(btn, "click").defaultPrevented).toBe(true);
    expect(leaked).toBe(0);
  });

  it("#alignToolbar button opts back in to touch-action", () => {
    // jsdom applies no stylesheet, so this reads index.html as text.
    // touch-action is not inherited but the EFFECTIVE value is the
    // intersection with every ancestor's — and #canvas sets `none`, so
    // without this rule iOS adds its double-tap-zoom delay before the
    // button will act (brain#294 made the same rule load-bearing for
    // every other chrome control).
    const html = readFileSync(join(process.cwd(), "src/editor/index.html"), "utf8");
    const rule = html.match(/#alignToolbar button \{[^}]*\}/);
    expect(rule, "#alignToolbar button rule must exist").not.toBeNull();
    expect(rule![0]).toContain("touch-action: manipulation");
  });
});
