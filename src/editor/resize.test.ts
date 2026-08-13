// Full pin of the box-resize mode toggle. The module is a single
// module-level string — the whole contract is the toggle semantics
// (same id → off, different id → switch) that keys.ts relies on for E
// and Escape.

import { beforeEach, describe, expect, it } from "vitest";
import { clearBoxResize, resizingBoxId, toggleBoxResize } from "./resize.ts";

// Module-level state persists across tests: always start from "no box
// in resize mode" rather than trusting test order.
beforeEach(() => {
  clearBoxResize();
});

describe("toggleBoxResize", () => {
  it("turns resize mode on for a box and reports true", () => {
    expect(toggleBoxResize("b1")).toBe(true);
    expect(resizingBoxId()).toBe("b1");
  });

  it("toggles OFF when pressed again for the same box", () => {
    toggleBoxResize("b1");
    // Second E on the same box exits the mode — the return value is
    // what keys.ts uses for the status message.
    expect(toggleBoxResize("b1")).toBe(false);
    expect(resizingBoxId()).toBeNull();
  });

  it("switches directly to another box without an off step", () => {
    toggleBoxResize("b1");
    expect(toggleBoxResize("b2")).toBe(true);
    // One box at a time: b2 replaces b1, no dual-resize state.
    expect(resizingBoxId()).toBe("b2");
  });

  it("a full on-off-on cycle lands back in resize mode", () => {
    toggleBoxResize("b1");
    toggleBoxResize("b1");
    expect(toggleBoxResize("b1")).toBe(true);
    expect(resizingBoxId()).toBe("b1");
  });
});

describe("clearBoxResize", () => {
  it("drops the mode (Escape / self-heal path)", () => {
    toggleBoxResize("b1");
    clearBoxResize();
    expect(resizingBoxId()).toBeNull();
  });

  it("is idempotent when nothing is resizing", () => {
    clearBoxResize();
    expect(resizingBoxId()).toBeNull();
    // And a toggle after a clear behaves like a fresh ON, not a switch.
    expect(toggleBoxResize("b9")).toBe(true);
    expect(resizingBoxId()).toBe("b9");
  });
});
