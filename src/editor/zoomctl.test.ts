// @vitest-environment jsdom
//
// The bottom-left zoom cluster [−][%][+]. These tests drive the REAL
// viewport module (no mocks) because the control's whole contract is
// arithmetic through it: a step multiplies viewport.s by exactly 1.25
// anchored at the window centre, the readout/disable flags follow
// every applyViewport(), and a double-activation of the % readout is
// Cmd/Ctrl+0.
//
// Activation follows the modebar/help pattern: pointerup + guarded
// click, latched so a pointerup and its trailing synthetic click are
// one activation (see help.test.ts). The latch clears on
// setTimeout(..., 0), so two SYNCHRONOUS dispatches always count as
// one — tests that need two distinct activations await a macrotask
// between them.
//
// performance.now() is stubbed with a hand-advanced clock: the
// double-tap window is 400ms and waiting real time for the negative
// cases would be slow and flaky. The clock starts far from 0 and only
// moves forward — attachZoomControl seeds its tap record with 0 (not
// -Infinity), so a clock near 0 would sit inside the accidental
// "first tap counts as a double-tap" window (see the lastLevelTap
// seed bug note below; touch-chrome learned the same lesson).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachZoomControl, levelTapAdvance, zoomDisplay } from "./zoomctl.ts";
import {
  applyViewport,
  MAX_SCALE,
  MIN_SCALE,
  viewport,
  wireViewportSync,
  withSuppressedViewSync,
} from "./viewport.ts";

const byId = (id: string): HTMLElement => document.getElementById(id)!;

const send = (el: Element, type: string): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

// A tap as the browser reports it: pointerup, then the synthetic
// click. The latch makes the pair a single activation.
const tap = (el: Element): void => {
  send(el, "pointerup");
  send(el, "click");
};

// One macrotask: lets the setTimeout(..., 0) latch clear so the next
// dispatch counts as a NEW activation. Two synchronous dispatches are
// always one activation — that's the point of the latch.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Window-centre anchor, from jsdom's window (1024×768 by default) —
// computed, not hardcoded, so the assertions state the invariant.
const cx = (): number => window.innerWidth / 2;
const cy = (): number => window.innerHeight / 2;

const outBtn = (): HTMLButtonElement =>
  byId("zoomCtl").querySelectorAll("button")[0] as HTMLButtonElement;
const level = (): HTMLButtonElement =>
  byId("zoomLevel") as HTMLButtonElement;
const inBtn = (): HTMLButtonElement =>
  byId("zoomCtl").querySelectorAll("button")[2] as HTMLButtonElement;

// applyViewport() writes transforms into these layers and throws on a
// missing id, so the fixture mirrors index.html's skeleton. Built
// ONCE: the control attaches once per page in real life, and
// viewport.ts caches #zoom-indicator on first use — rebuilding the
// DOM per test would leave that cache pointing at a detached node.
const buildFixtureOnce = (): void => {
  if (document.getElementById("canvas")) return;
  for (const id of [
    "bg-layer",
    "canvas",
    "edge-label-layer",
    "line-layer",
    "stroke-layer",
    "edge-layer",
    "ghost-line",
    "zoom-indicator",
  ]) {
    const d = document.createElement("div");
    d.id = id;
    document.body.appendChild(d);
  }
};

let map: { boxes: Array<{ id: string; x: number; y: number }> };
let nowMs = 0;

beforeEach(async () => {
  // Synchronous tests run back-to-back without yielding, so a latch
  // set by the previous test's tap would still be armed here. One
  // macrotask lets every pending setTimeout(..., 0) latch clear.
  await settle();
  buildFixtureOnce();
  map = { boxes: [{ id: "b1", x: 100, y: 50 }] };
  // Forward-only clock, and never near 0: `let lastLevelTap = 0` in
  // attachZoomControl means any % tap with performance.now() < 400
  // reads as the second half of a double-tap (reported as a product
  // bug; the seed should be -Infinity). Tests stay out of that window.
  nowMs += 100_000;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  attachZoomControl({ currentMap: () => map });
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  applyViewport();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structure", () => {
  it("builds [−][%][+] with accessible labels", () => {
    const buttons = byId("zoomCtl").querySelectorAll("button");
    expect(buttons.length).toBe(3);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Zoom out");
    expect(buttons[1]!.id).toBe("zoomLevel");
    expect(buttons[1]!.getAttribute("aria-label")).toContain("double-click to reset");
    expect(buttons[2]!.getAttribute("aria-label")).toBe("Zoom in");
  });

  it("attaches once — a second call is a no-op", () => {
    attachZoomControl({ currentMap: () => map });
    expect(document.querySelectorAll("#zoomCtl").length).toBe(1);
    expect(byId("zoomCtl").querySelectorAll("button").length).toBe(3);
  });

  it("readout is correct at wiring, before any zoom event", () => {
    // wireViewportDisplay invokes the callback once at registration —
    // the readout must not wait for the first pan/zoom.
    expect(level().textContent).toBe("100%");
    expect(outBtn().disabled).toBe(false);
    expect(inBtn().disabled).toBe(false);
  });
});

describe("step buttons", () => {
  it("+ multiplies the scale by exactly 1.25, anchored at the window centre", () => {
    tap(inBtn());
    expect(viewport.s).toBe(1.25);
    // Anchor invariant: the data point under the window centre stays
    // under it. With x=y=0, s=1 that solves to c - c·1.25 = -c/4.
    expect(viewport.x).toBe(cx() - cx() * 1.25);
    expect(viewport.y).toBe(cy() - cy() * 1.25);
    expect(level().textContent).toBe("125%");
  });

  it("− divides the scale by 1.25, same anchor", () => {
    tap(outBtn());
    expect(viewport.s).toBeCloseTo(0.8, 12);
    expect(viewport.x).toBeCloseTo(cx() - cx() * 0.8, 9);
    expect(viewport.y).toBeCloseTo(cy() - cy() * 0.8, 9);
    expect(level().textContent).toBe("80%");
  });

  it("+ then − returns to the starting scale (reciprocal steps)", async () => {
    tap(inBtn());
    await settle();
    tap(outBtn());
    expect(viewport.s).toBeCloseTo(1, 12);
  });

  it("a pointerup and its trailing click are ONE step, not two", () => {
    // Without the latch this synchronous pair would land 1.25² = 1.5625.
    send(inBtn(), "pointerup");
    send(inBtn(), "click");
    expect(viewport.s).toBe(1.25);
  });

  it("two separate activations are two steps", async () => {
    tap(inBtn());
    await settle(); // latch clears on a macrotask
    tap(inBtn());
    expect(viewport.s).toBeCloseTo(1.5625, 12);
    expect(level().textContent).toBe("156%");
  });

  it("click alone activates — keyboard Enter/Space path", () => {
    send(inBtn(), "click");
    expect(viewport.s).toBe(1.25);
  });
});

describe("clamping and disable states", () => {
  it("zooming in past MAX clamps to MAX and disables +", () => {
    viewport.s = 7;
    applyViewport();
    tap(inBtn()); // 7 × 1.25 = 8.75 → clamped to 8
    expect(viewport.s).toBe(MAX_SCALE);
    expect(level().textContent).toBe("800%");
    expect(inBtn().disabled).toBe(true);
    expect(outBtn().disabled).toBe(false);
  });

  it("zooming out past MIN clamps to MIN and disables −", () => {
    viewport.s = 0.55;
    applyViewport();
    tap(outBtn()); // 0.55 / 1.25 = 0.44 → clamped to 0.5
    expect(viewport.s).toBe(MIN_SCALE);
    expect(level().textContent).toBe("50%");
    expect(outBtn().disabled).toBe(true);
    expect(inBtn().disabled).toBe(false);
  });

  it("a disabled − does not even flash the zoom indicator", () => {
    // zoomAt() clamps anyway, so viewport.s alone can't distinguish
    // "button refused" from "zoomAt clamped to the same value". The
    // indicator can: zoomAt flashes it even on a clamped request, so a
    // silent indicator proves onActivate never ran.
    viewport.s = MIN_SCALE;
    applyViewport();
    byId("zoom-indicator").classList.remove("visible");
    tap(outBtn());
    expect(viewport.s).toBe(MIN_SCALE);
    expect(byId("zoom-indicator").classList.contains("visible")).toBe(false);
    // Sanity: the same tap on the still-enabled + does flash it.
    tap(inBtn());
    expect(byId("zoom-indicator").classList.contains("visible")).toBe(true);
  });

  it("readout rounds to the nearest percent", () => {
    viewport.s = 1.236; // 123.6% — floor would show 123
    applyViewport();
    expect(level().textContent).toBe("124%");
  });
});

describe("double-tap reset on the % readout", () => {
  beforeEach(() => {
    viewport.s = 2;
    viewport.x = -300;
    viewport.y = -200;
    applyViewport();
  });

  it("two taps inside 400ms reset to 100% and recenter", async () => {
    tap(level());
    nowMs += 100;
    await settle();
    tap(level());
    expect(viewport.s).toBe(1);
    // recenter() lands the b1 box (no rendered element, so its stored
    // top-left) on the window centre at the new scale.
    expect(viewport.x).toBe(cx() - 100);
    expect(viewport.y).toBe(cy() - 50);
    expect(level().textContent).toBe("100%");
  });

  it("a single tap does nothing", async () => {
    tap(level());
    nowMs += 500;
    await settle();
    expect(viewport.s).toBe(2);
  });

  it("two taps slower than 400ms do not reset — but a third within it does", async () => {
    tap(level());
    nowMs += 450;
    await settle();
    tap(level()); // too slow: records, doesn't reset
    expect(viewport.s).toBe(2);
    nowMs += 100;
    await settle();
    tap(level()); // pairs with tap #2
    expect(viewport.s).toBe(1);
  });

  it("a pointerup with its trailing click is one tap, not an instant double-tap", async () => {
    // Without the latch, the synchronous pointerup+click pair would be
    // two activations 0ms apart — inside the 400ms window — and every
    // single tap would reset.
    tap(level());
    await settle();
    expect(viewport.s).toBe(2);
  });

  it("a completed reset clears the record — the next tap starts a fresh pair", async () => {
    tap(level());
    nowMs += 100;
    await settle();
    tap(level());
    expect(viewport.s).toBe(1); // reset happened
    await settle();
    tap(inBtn()); // re-zoom so a spurious second reset would be visible
    expect(viewport.s).toBe(1.25);
    nowMs += 50; // still within 400ms of the resetting tap
    await settle();
    tap(level());
    expect(viewport.s).toBe(1.25); // single tap after a reset must not reset again
  });
});

describe("readout through the display hook", () => {
  it("updates even while view-URL sync is suspended", () => {
    // Load-time / resize recenters run under withSuppressedViewSync so
    // they don't stomp a bookmarked URL — but the on-screen percentage
    // must still track the real scale.
    const urlSync = vi.fn();
    wireViewportSync(urlSync);
    withSuppressedViewSync(() => {
      viewport.s = 2;
      applyViewport();
    });
    expect(level().textContent).toBe("200%");
    expect(urlSync).not.toHaveBeenCalled();
    // Sanity: outside suppression the URL hook fires again.
    applyViewport();
    expect(urlSync).toHaveBeenCalledTimes(1);
  });
});

describe("presses never reach the canvas handlers", () => {
  // A double-click on the % readout must reset zoom, not create a box
  // under it — every relevant event is stopped at the button.
  for (const type of ["mousedown", "dblclick", "pointerup", "click"]) {
    it(`${type} on a zoom button does not bubble to document`, () => {
      const leaked = vi.fn();
      document.addEventListener(type, leaked);
      try {
        send(level(), type);
        expect(leaked).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener(type, leaked);
      }
    });
  }

  it("pointerup is default-prevented (no synthetic mouse follow-ups wanted)", () => {
    const e = send(inBtn(), "pointerup");
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("zoomDisplay (pure)", () => {
  it("formats and rounds the percentage", () => {
    expect(zoomDisplay(1).text).toBe("100%");
    expect(zoomDisplay(1.236).text).toBe("124%");
    expect(zoomDisplay(0.8).text).toBe("80%");
  });

  it("flags the clamps, absorbing float drift", () => {
    expect(zoomDisplay(1)).toEqual({ text: "100%", outDisabled: false, inDisabled: false });
    expect(zoomDisplay(MIN_SCALE).outDisabled).toBe(true);
    expect(zoomDisplay(MAX_SCALE).inDisabled).toBe(true);
    // Repeated ×/÷1.25 steps land epsilon-off the clamp; the flags
    // must still latch there or the buttons re-enable at the limit.
    expect(zoomDisplay(MIN_SCALE + 1e-9).outDisabled).toBe(true);
    expect(zoomDisplay(MAX_SCALE - 1e-9).inDisabled).toBe(true);
    expect(zoomDisplay(MIN_SCALE + 1e-3).outDisabled).toBe(false);
    expect(zoomDisplay(MAX_SCALE - 1e-3).inDisabled).toBe(false);
  });
});

describe("levelTapAdvance (pure)", () => {
  it("a tap inside the window resets and clears the record", () => {
    expect(levelTapAdvance(1000, 1399)).toEqual({ reset: true, last: 0 });
  });

  it("a tap outside the window records its own time", () => {
    expect(levelTapAdvance(1000, 1400)).toEqual({ reset: false, last: 1400 });
    expect(levelTapAdvance(1000, 5000)).toEqual({ reset: false, last: 5000 });
  });
});

// Regression for the -Infinity seed: with a 0 seed, the FIRST tap of a
// page's life within DOUBLE_MS of time-origin paired with "tap at 0"
// and instantly reset the view (the help.ts latch-sentinel lesson).
describe("first-tap-of-page-life", () => {
  it("a single tap in the first 400ms of the page does not reset", () => {
    const early = levelTapAdvance(-Infinity, 100);
    expect(early.reset).toBe(false);
    expect(early.last).toBe(100);
  });
});
