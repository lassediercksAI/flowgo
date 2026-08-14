// @vitest-environment jsdom
//
// The embed scroll bridge's whole contract is WHICH gestures leave
// the frame: plain wheel and vertical bg swipes go to the host, and
// everything that means "using the editor" must reach the editor's
// own document-level listeners untouched. jsdom has no real iframe
// parent, so window.parent is stubbed per test and the "reaches the
// editor" half is asserted through a document-level listener standing
// in for mouse.ts/touch.ts — same plain-Event harness as
// touch-pinch.test.ts (touches defined on the event object).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let detach: () => void = () => {};

const setup = async (embed: boolean) => {
  vi.resetModules();
  const posted: Array<{ flowgo: string; dy: number }> = [];
  const fakeParent = {
    postMessage: (m: { flowgo: string; dy: number }) => posted.push(m),
  };
  Object.defineProperty(window, "parent", { value: fakeParent, configurable: true });
  window.history.replaceState(null, "", embed ? "/?embed=1" : "/");
  document.body.innerHTML = `<div id="canvas"><div id="bg-layer"></div><div class="box" data-id="b1"></div></div>`;
  const mod = await import("./embed.ts");
  detach = mod.attachEmbedBridge();
  return { posted };
};

const wheel = (opts: Partial<WheelEvent> = {}): WheelEvent => {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120, ...opts });
  return e;
};

const touch = (type: string, target: Element, x: number, y: number, id = 1): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", {
    value: type === "touchend" || type === "touchcancel"
      ? []
      : [{ identifier: id, clientX: x, clientY: y, target }],
  });
  Object.defineProperty(e, "target", { value: target });
  return e;
};

const bg = () => document.getElementById("bg-layer")!;
const box = () => document.querySelector(".box")!;

describe("embed scroll bridge", () => {
  let editorSaw: string[];
  const record = (e: Event) => editorSaw.push(e.type);

  beforeEach(() => {
    editorSaw = [];
    document.addEventListener("wheel", record);
    document.addEventListener("touchmove", record);
  });
  afterEach(() => {
    detach();
    document.removeEventListener("wheel", record);
    document.removeEventListener("touchmove", record);
  });

  it("is inert without ?embed=1", async () => {
    const { posted } = await setup(false);
    bg().dispatchEvent(wheel());
    expect(posted).toHaveLength(0);
    expect(editorSaw).toContain("wheel");
  });

  it("forwards plain wheel to the host and starves the editor", async () => {
    const { posted } = await setup(true);
    const e = wheel();
    bg().dispatchEvent(e);
    expect(posted).toEqual([{ flowgo: "embed-scroll", dy: 120 }]);
    expect(e.defaultPrevented).toBe(true);
    expect(editorSaw).not.toContain("wheel");
  });

  it("modifier wheel (zoom / trackpad pinch) stays in the editor", async () => {
    const { posted } = await setup(true);
    bg().dispatchEvent(wheel({ ctrlKey: true }));
    expect(posted).toHaveLength(0);
    expect(editorSaw).toContain("wheel");
  });

  it("normalizes Firefox line-mode deltas", async () => {
    const { posted } = await setup(true);
    bg().dispatchEvent(wheel({ deltaMode: 1, deltaY: 3 }));
    expect(posted[0]!.dy).toBe(48);
  });

  it("a vertical bg swipe scrolls the host page", async () => {
    const { posted } = await setup(true);
    bg().dispatchEvent(touch("touchstart", bg(), 100, 200));
    bg().dispatchEvent(touch("touchmove", bg(), 101, 180));
    bg().dispatchEvent(touch("touchmove", bg(), 101, 160));
    expect(posted.map((m) => m.dy)).toEqual([20, 20]);
    expect(editorSaw).not.toContain("touchmove");
  });

  it("a horizontal bg swipe is released to the editor as a pan", async () => {
    const { posted } = await setup(true);
    bg().dispatchEvent(touch("touchstart", bg(), 100, 200));
    bg().dispatchEvent(touch("touchmove", bg(), 130, 202));
    expect(posted).toHaveLength(0);
    expect(editorSaw).toContain("touchmove");
  });

  it("touches starting on a box never forward — dragging works", async () => {
    const { posted } = await setup(true);
    box().dispatchEvent(touch("touchstart", box(), 100, 200));
    box().dispatchEvent(touch("touchmove", box(), 100, 150));
    expect(posted).toHaveLength(0);
    expect(editorSaw).toContain("touchmove");
  });

  it("sub-threshold movement (a tap) falls through untouched", async () => {
    const { posted } = await setup(true);
    bg().dispatchEvent(touch("touchstart", bg(), 100, 200));
    bg().dispatchEvent(touch("touchmove", bg(), 101, 204));
    expect(posted).toHaveLength(0);
    expect(editorSaw).toContain("touchmove");
  });

  it("the lock clears on touchend", async () => {
    const { posted } = await setup(true);
    bg().dispatchEvent(touch("touchstart", bg(), 100, 200));
    bg().dispatchEvent(touch("touchmove", bg(), 100, 150));
    bg().dispatchEvent(touch("touchend", bg(), 100, 150));
    bg().dispatchEvent(touch("touchstart", bg(), 100, 200, 2));
    bg().dispatchEvent(touch("touchmove", bg(), 140, 201, 2));
    expect(posted.map((m) => m.dy)).toEqual([50]); // second swipe locked horizontal
  });

  it("adds the embed-mode body class for the chrome trim", async () => {
    await setup(true);
    expect(document.body.classList.contains("embed-mode")).toBe(true);
  });
});
