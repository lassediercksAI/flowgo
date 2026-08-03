// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { renderFlowgoBlock } from "../src/render.ts";

const SAMPLE = `
box b1 "Project" 120 100
box b2 "Notes"   320 100
edge b1:r b2:l
anchor b1
`;

describe("renderFlowgoBlock", () => {
  it("renders boxes with their labels", () => {
    const el = document.createElement("div");
    renderFlowgoBlock(el, SAMPLE);

    const boxes = el.querySelectorAll(".fgi-box");
    expect(boxes.length).toBe(2);
    const labels = Array.from(boxes).map((b) => b.textContent);
    expect(labels).toContain("Project");
    expect(labels).toContain("Notes");
  });

  it("does not throw on an empty .flowgo string", () => {
    const el = document.createElement("div");
    expect(() => renderFlowgoBlock(el, "")).not.toThrow();
    // No boxes, but the wrapper itself should still be present.
    expect(el.querySelector(".flowgo-embed")).not.toBeNull();
  });

  it("does not throw on a malformed .flowgo string, and renders a fallback instead", () => {
    const el = document.createElement("div");
    expect(() => renderFlowgoBlock(el, "this is not a valid flowgo directive")).not.toThrow();
    const error = el.querySelector(".flowgo-embed-error");
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("flowgo: could not render this block");
    // The failed render must not leave any partial flowgo DOM behind.
    expect(el.querySelector(".fgi-root")).toBeNull();
  });

  it("replaces contents rather than appending when called twice on the same container", () => {
    const el = document.createElement("div");
    renderFlowgoBlock(el, SAMPLE);
    expect(el.querySelectorAll(".fgi-box").length).toBe(2);

    const single = `box only "Solo" 40 40`;
    renderFlowgoBlock(el, single);

    const boxes = el.querySelectorAll(".fgi-box");
    expect(boxes.length).toBe(1);
    expect(boxes[0]?.textContent).toBe("Solo");
    // Only one wrapper should exist — no leftover from the first render.
    expect(el.querySelectorAll(".flowgo-embed").length).toBe(1);
  });
});
