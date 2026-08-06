// @vitest-environment jsdom
//
// brain#257 — the help overlay's dismissal routes. The ✕ and the
// backdrop used to depend on the browser synthesizing mouse events from
// a tap (`click` / `mousedown`), which is exactly what the rest of the
// chrome stopped relying on (see zoomctl.ts / contextbar.ts). These
// tests pin the pointer-first behaviour and the "one activation, not
// two" latch that keeps a pointerup and its trailing click from
// cancelling each other out.

import { beforeEach, describe, expect, it } from "vitest";
import { attachHelpListeners, isHelpOpen, setHelpOpen } from "./help.ts";

const OVERLAY = `
<div id="helpOverlay" class="hidden">
  <div id="helpModal">
    <button id="helpClose"><svg id="closeIcon"></svg></button>
    <div class="help-coarse"><p id="helpText">gestures</p></div>
  </div>
</div>
<button id="helpBtn"></button>`;

const byId = (id: string): HTMLElement => document.getElementById(id)!;

const send = (el: Element, type: string): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

// A touch tap as the browser reports it: pointerup, then a click that
// may arrive much later (or not at all).
const tap = (el: Element): void => {
  send(el, "pointerup");
  send(el, "click");
};

beforeEach(() => {
  document.body.innerHTML = OVERLAY;
  attachHelpListeners();
});

describe("opening and closing", () => {
  it("starts closed", () => {
    expect(isHelpOpen()).toBe(false);
  });

  it("a tap on the help button opens it", () => {
    tap(byId("helpBtn"));
    expect(isHelpOpen()).toBe(true);
  });

  it("a tap on the ✕ closes it", () => {
    setHelpOpen(true);
    tap(byId("helpClose"));
    expect(isHelpOpen()).toBe(false);
  });

  // setHelpOpen is idempotent, so a double activation is invisible on
  // the overlay itself. Force it into the open by flipping the state
  // between the pointerup and the trailing click: if the click were a
  // second activation it would undo the flip.
  it("a pointerup and its trailing click are one activation", () => {
    send(byId("helpBtn"), "pointerup");
    expect(isHelpOpen()).toBe(true);
    setHelpOpen(false);
    send(byId("helpBtn"), "click");
    expect(isHelpOpen()).toBe(false);
  });

  it("the latch is per-button — open then close still works", () => {
    tap(byId("helpBtn"));
    tap(byId("helpClose"));
    expect(isHelpOpen()).toBe(false);
  });

  it("pointerup alone is enough — no click required", () => {
    send(byId("helpBtn"), "pointerup");
    expect(isHelpOpen()).toBe(true);
    send(byId("helpClose"), "pointerup");
    expect(isHelpOpen()).toBe(false);
  });

  it("click alone is enough — no pointerup required", () => {
    send(byId("helpBtn"), "click");
    expect(isHelpOpen()).toBe(true);
    send(byId("helpClose"), "click");
    expect(isHelpOpen()).toBe(false);
  });

  // The icon is pointer-events: none in the real stylesheet, but jsdom
  // has no layout — this asserts the listener is on the button, so an
  // event that does surface from a child still activates it.
  it("an event from inside the button still activates it", () => {
    setHelpOpen(true);
    send(byId("closeIcon"), "pointerup");
    expect(isHelpOpen()).toBe(false);
  });
});

describe("backdrop", () => {
  it("a tap on the backdrop closes the overlay", () => {
    setHelpOpen(true);
    send(byId("helpOverlay"), "pointerdown");
    expect(isHelpOpen()).toBe(false);
  });

  it("a tap inside the modal does not close the overlay", () => {
    setHelpOpen(true);
    send(byId("helpText"), "pointerdown");
    expect(isHelpOpen()).toBe(true);
  });
});

describe("wiring is defensive", () => {
  it("attaches even when the buttons are missing", () => {
    document.body.innerHTML = `<div id="helpOverlay" class="hidden"></div>`;
    expect(() => attachHelpListeners()).not.toThrow();
  });

  it("throws a named error when the overlay itself is missing", () => {
    document.body.innerHTML = "";
    expect(() => attachHelpListeners()).toThrow(/helpOverlay missing/);
  });
});
