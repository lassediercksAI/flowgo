// @vitest-environment jsdom
//
// text-mode.ts, pinned completely: the transient single-shot mode
// flag (state + body class + status line move together), the wiring
// guard, and the pending palette/font for the next placed text item.
//
// The single-shot exit itself (placing a text item turns the mode
// off) lives in the mouse/touch placement paths, not here — this
// module only owns the flag those paths flip.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTextFont,
  getTextPalette,
  isTextMode,
  setTextFont,
  setTextMode,
  setTextPalette,
  wireTextMode,
} from "./text-mode.ts";

const ARMED_STATUS = "text mode — click to place text · T or Escape to exit";

let statuses: string[] = [];

beforeEach(() => {
  wireTextMode({
    setStatus: (s) => {
      statuses.push(s);
    },
  });
  // Module state persists across tests in this file: drain it through
  // the module's own setters, then discard the resulting status noise.
  setTextMode(false);
  setTextPalette(1);
  setTextFont(1);
  document.body.className = "";
  statuses = [];
});

describe("initial state (fresh module)", () => {
  // The static import above is shared and already poked by other
  // tests; defaults need a pristine copy.
  it("starts disarmed with palette 1 and font 1", async () => {
    vi.resetModules();
    const fresh = await import("./text-mode.ts");
    expect(fresh.isTextMode()).toBe(false);
    expect(fresh.getTextPalette()).toBe(1);
    expect(fresh.getTextFont()).toBe(1);
    expect(document.body.classList.contains("text-mode")).toBe(false);
  });

  it("setTextMode before wireTextMode throws the wiring error", async () => {
    vi.resetModules();
    const fresh = await import("./text-mode.ts");
    expect(() => fresh.setTextMode(true)).toThrow(
      "text-mode: wireTextMode() not called",
    );
  });

  it("getters and the pending setters work unwired (no status involved)", async () => {
    vi.resetModules();
    const fresh = await import("./text-mode.ts");
    expect(() => fresh.setTextPalette(3)).not.toThrow();
    expect(fresh.getTextPalette()).toBe(3);
    expect(() => fresh.isTextMode()).not.toThrow();
  });
});

describe("arming and disarming", () => {
  it("arming sets the flag, the body class and the hint status", () => {
    setTextMode(true);
    expect(isTextMode()).toBe(true);
    expect(document.body.classList.contains("text-mode")).toBe(true);
    expect(statuses).toEqual([ARMED_STATUS]);
  });

  it("arming when already armed is a full no-op", () => {
    setTextMode(true);
    setTextMode(true);
    expect(isTextMode()).toBe(true);
    expect(document.body.classList.contains("text-mode")).toBe(true);
    // No second status line — keys.ts calls this on every T press and
    // the status bar must not flicker.
    expect(statuses).toEqual([ARMED_STATUS]);
  });

  it("disarming clears the flag and class and reports select mode", () => {
    setTextMode(true);
    setTextMode(false);
    expect(isTextMode()).toBe(false);
    expect(document.body.classList.contains("text-mode")).toBe(false);
    expect(statuses).toEqual([ARMED_STATUS, "select mode"]);
  });

  it("disarming when already disarmed is a full no-op", () => {
    setTextMode(false);
    expect(isTextMode()).toBe(false);
    expect(statuses).toEqual([]);
  });

  it("flag and body class stay in lockstep across re-arms", () => {
    for (const on of [true, false, true, true, false]) {
      setTextMode(on);
      expect(isTextMode()).toBe(on);
      expect(document.body.classList.contains("text-mode")).toBe(on);
    }
  });
});

describe("pending palette / font for the next placed item", () => {
  it("accepts the whole 1–9 range inclusive", () => {
    setTextPalette(9);
    expect(getTextPalette()).toBe(9);
    setTextPalette(1);
    expect(getTextPalette()).toBe(1);
    setTextFont(9);
    expect(getTextFont()).toBe(9);
    setTextFont(1);
    expect(getTextFont()).toBe(1);
  });

  it("rejects out-of-range values, keeping the previous choice", () => {
    setTextPalette(4);
    setTextPalette(0);
    setTextPalette(10);
    setTextPalette(-3);
    expect(getTextPalette()).toBe(4);
    setTextFont(7);
    setTextFont(0);
    setTextFont(10);
    expect(getTextFont()).toBe(7);
  });

  it("palette and font are independent of each other and of the mode", () => {
    setTextPalette(3);
    expect(getTextFont()).toBe(1);
    setTextFont(5);
    expect(getTextPalette()).toBe(3);
    // Placing/exiting text mode must not reset the pending style —
    // it persists until changed, like the brush palette.
    setTextMode(true);
    setTextMode(false);
    expect(getTextPalette()).toBe(3);
    expect(getTextFont()).toBe(5);
  });
});
