// @vitest-environment jsdom
//
// brain#294 — the ↑ Up button "does not work at all".
//
// It was the last chrome control in the editor whose ONLY activation
// path was `click`. On iOS Safari a tap does not reliably produce one
// while touch.ts holds document-level {passive:false} touch listeners
// (brain#256/#257), and Up is the only way out of a submap on a phone.
// Reproduced in a real browser by suppressing the tap's synthesized
// click: #helpBtn and #zoomCtl kept working through their guarded
// `pointerup`, #upBtn did nothing.
//
// These tests pin BOTH halves of the fix:
//   - a pointerup with no click still activates (the iOS case),
//   - a click with no pointerup still activates (keyboard, and any
//     engine that skips pointer events),
//   - one tap is one activation, not two,
//   - but three fast taps are three activations — Up is repeatable,
//     unlike the idempotent toggles help.ts's latch was written for,
//     so climbing three levels quickly must climb three levels.
// plus the stylesheet half, which jsdom cannot see: chrome buttons
// need `touch-action: manipulation` of their own, because html/body
// set `none` and the effective value is the intersection.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { attachToolbarButtons } from "./toolbar.ts";

const TOOLBAR = `
<div id="toolbar">
  <button id="upBtn"><svg id="upIcon"></svg> Up</button>
  <button id="downloadBtn">Download .flowgo</button>
  <button id="reshareBtn">Save as new share</button>
  <span id="path"></span>
</div>`;

const byId = (id: string): HTMLElement => document.getElementById(id)!;

const send = (el: Element, type: string): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

// A touch tap as the browser reports it when everything goes well:
// pointerup, then a synthesized click that may arrive much later.
const tap = (el: Element): void => {
  send(el, "pointerup");
  send(el, "click");
};

// The failure this card is about: the tap happens, the click never
// comes.
const tapWithNoSyntheticClick = (el: Element): void => {
  send(el, "pointerup");
};

let goUp: ReturnType<typeof vi.fn>;
let downloadFlowgo: ReturnType<typeof vi.fn>;
let reshare: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = TOOLBAR;
  goUp = vi.fn();
  downloadFlowgo = vi.fn();
  reshare = vi.fn();
  attachToolbarButtons({ goUp, downloadFlowgo, reshare });
});

describe("Up survives a tap that produces no click", () => {
  it("a pointerup with no synthesized click still navigates up", () => {
    tapWithNoSyntheticClick(byId("upBtn"));
    expect(goUp).toHaveBeenCalledTimes(1);
  });

  it("a click with no pointerup still navigates up (keyboard)", () => {
    send(byId("upBtn"), "click");
    expect(goUp).toHaveBeenCalledTimes(1);
  });

  it("one tap is one level, not two", () => {
    tap(byId("upBtn"));
    expect(goUp).toHaveBeenCalledTimes(1);
  });

  it("a tap whose click arrives late is still one level", () => {
    send(byId("upBtn"), "pointerup");
    send(byId("upBtn"), "click");
    expect(goUp).toHaveBeenCalledTimes(1);
  });

  it("three fast taps climb three levels — Up is repeatable", () => {
    tap(byId("upBtn"));
    tap(byId("upBtn"));
    tap(byId("upBtn"));
    expect(goUp).toHaveBeenCalledTimes(3);
  });

  it("a tap on the icon inside the button counts (events bubble)", () => {
    tapWithNoSyntheticClick(byId("upIcon"));
    expect(goUp).toHaveBeenCalledTimes(1);
  });
});

describe("the buttons beside it, same bar, same hazard", () => {
  it("Download survives a click-less tap", () => {
    tapWithNoSyntheticClick(byId("downloadBtn"));
    expect(downloadFlowgo).toHaveBeenCalledTimes(1);
  });

  it("Save as new share survives a click-less tap", () => {
    tapWithNoSyntheticClick(byId("reshareBtn"));
    expect(reshare).toHaveBeenCalledTimes(1);
  });

  it("each button activates only its own action", () => {
    tap(byId("upBtn"));
    expect(downloadFlowgo).not.toHaveBeenCalled();
    expect(reshare).not.toHaveBeenCalled();
  });
});

describe("wiring is defensive about the DOM it is handed", () => {
  it("an absent button is skipped, not thrown on", () => {
    document.body.innerHTML = `<div id="toolbar"></div>`;
    expect(() => attachToolbarButtons({ goUp, downloadFlowgo, reshare })).not.toThrow();
  });
});

describe("the stylesheet half of the contract", () => {
  // jsdom applies no CSS, so the behavioural tests above stay green
  // even if the `touch-action` that makes the tap reach the button in
  // the first place goes away. Read the source and assert it.
  const css = (): string =>
    readFileSync(join(process.cwd(), "src/editor/index.html"), "utf8");

  const toolbarButtonRule = (): string => {
    const src = css();
    const at = src.indexOf("#toolbar button {");
    expect(at, "no `#toolbar button` rule in index.html").toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("}", at));
  };

  it("html/body still opt out of browser gestures, which is why the button must opt back in", () => {
    expect(css()).toMatch(/html,\s*body[^{]*\{[^}]*touch-action:\s*none/);
  });

  it("#toolbar button carries its own touch-action: manipulation", () => {
    expect(toolbarButtonRule()).toMatch(/touch-action:\s*manipulation/);
  });

  it("#toolbar button is not text-selectable, so a tap can't become a selection", () => {
    expect(toolbarButtonRule()).toMatch(/-webkit-user-select:\s*none/);
  });
});
