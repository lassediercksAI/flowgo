// @vitest-environment jsdom
//
// inline.ts is the shared read-only renderer behind the gallery,
// obsidian-flowgo, vscode-flowgo, remark-flowgo, and browser-flowgo —
// but had no dedicated test of its own; those five surfaces only
// exercise it indirectly through their own wrapper logic. This file
// tests renderFlowgo() directly, in isolation from any of them.
import { describe, it, expect, beforeEach } from "vitest";
import { renderFlowgo } from "./inline.ts";

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

describe("renderFlowgo: basic rendering", () => {
  it("renders boxes with their labels", () => {
    renderFlowgo(container, "node a hello 0 0\nnode b world 200 0\n");
    const boxes = container.querySelectorAll(".fgi-box");
    expect(boxes.length).toBe(2);
    expect(Array.from(boxes).map((b) => b.textContent)).toEqual(["hello", "world"]);
  });

  it("renders edges as SVG lines", () => {
    renderFlowgo(container, "node a hi 0 0\nnode b there 200 0\nedge a b\n");
    const lines = container.querySelectorAll(".fgi-edge-line");
    expect(lines.length).toBe(1);
  });

  // brain#266: an embed that drops the edge label would silently lose
  // the meaning of the connection — the label is the point of the map.
  it("renders the edge label at the midpoint, and nothing when absent", () => {
    renderFlowgo(container, 'node a hi 0 0\nnode b there 200 100\nedge a b 1 "depends on"\n');
    const labels = container.querySelectorAll<HTMLElement>(".fgi-edge-label");
    expect(labels.length).toBe(1);
    expect(labels[0]!.textContent).toBe("depends on");
    const line = container.querySelector(".fgi-edge-line")!;
    const mx = (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2;
    expect(labels[0]!.style.left).toBe(mx + "px");

    container.innerHTML = "";
    renderFlowgo(container, "node a hi 0 0\nnode b there 200 100\nedge a b\n");
    expect(container.querySelectorAll(".fgi-edge-label").length).toBe(0);
  });

  it("renders free-floating text elements", () => {
    renderFlowgo(container, 'text t1 "a note" 10 10\n');
    const texts = container.querySelectorAll(".fgi-text");
    expect(texts.length).toBe(1);
    expect(texts[0]?.textContent).toBe("a note");
  });

  it("renders static lines as SVG paths", () => {
    renderFlowgo(container, "line l1 0 0 100 100\n");
    expect(container.querySelectorAll(".fgi-line-line").length).toBe(1);
  });

  it("renders freehand strokes as SVG paths", () => {
    renderFlowgo(container, "stroke s1 0,0 10,10 20,0\n");
    expect(container.querySelectorAll(".fgi-stroke-line").length).toBe(1);
  });

  it("renders an empty document without throwing", () => {
    expect(() => renderFlowgo(container, "")).not.toThrow();
    expect(container.querySelectorAll(".fgi-box").length).toBe(0);
  });

  it("throws on genuinely malformed .flowgo syntax rather than silently swallowing it", () => {
    // renderFlowgo itself doesn't catch parse errors -- callers (every
    // downstream integration this session) are responsible for that,
    // and each one's own test suite covers its own try/catch. This
    // just documents/locks in that renderFlowgo is not itself
    // fault-tolerant to bad input.
    expect(() => renderFlowgo(container, "this is not valid flowgo syntax !!!")).toThrow();
  });
});

describe("renderFlowgo: shapes and palettes", () => {
  it("applies the hex/circle/triangle shape classes", () => {
    renderFlowgo(
      container,
      "node a hex 0 0\nnodeshape a 1\nnode b circ 300 0\nnodeshape b 2\nnode c tri 600 0\nnodeshape c 3\n",
    );
    const boxes = container.querySelectorAll(".fgi-box");
    expect(boxes[0]?.classList.contains("fgi-hex")).toBe(true);
    expect(boxes[1]?.classList.contains("fgi-circle")).toBe(true);
    expect(boxes[2]?.classList.contains("fgi-tri")).toBe(true);
  });

  it("applies a palette class for non-default palettes only", () => {
    renderFlowgo(container, "node a default 0 0\nnode b coloured 300 0 4 4\n");
    const boxes = container.querySelectorAll(".fgi-box");
    expect(boxes[0]?.className).not.toMatch(/fgi-palette-/);
    expect(boxes[1]?.classList.contains("fgi-palette-4")).toBe(true);
  });
});

describe("renderFlowgo: submap navigation", () => {
  const NESTED = [
    "node a parent 0 0",
    "map /a",
    "node child inside 0 0",
  ].join("\n");

  it("marks a box with a submap and lets goTo() navigate into it", () => {
    const instance = renderFlowgo(container, NESTED);
    const parentBox = container.querySelector(".fgi-box");
    expect(parentBox?.classList.contains("fgi-has-submap")).toBe(true);

    instance.goTo("/a");
    expect(instance.path).toBe("/a");
    const boxesAfter = container.querySelectorAll(".fgi-box");
    expect(boxesAfter.length).toBe(1);
    expect(boxesAfter[0]?.textContent).toBe("inside");
  });

  it("clicking a has-submap box navigates into it (drillIn default-on)", () => {
    const instance = renderFlowgo(container, NESTED);
    const parentBox = container.querySelector<HTMLElement>(".fgi-box.fgi-has-submap");
    expect(parentBox).not.toBeNull();
    parentBox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(instance.path).toBe("/a");
  });

  it("does not navigate on click when drillIn is disabled", () => {
    const instance = renderFlowgo(container, NESTED, { drillIn: false });
    const parentBox = container.querySelector<HTMLElement>(".fgi-box");
    parentBox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(instance.path).toBe("/");
  });

  it("does not render a breadcrumb bar when drillIn is disabled", () => {
    renderFlowgo(container, NESTED, { drillIn: false });
    expect(container.querySelector(".fgi-crumbs")).toBeNull();
  });

  it("renders a breadcrumb trail reflecting the current path by default", () => {
    const instance = renderFlowgo(container, NESTED);
    instance.goTo("/a");
    const crumbs = container.querySelector(".fgi-crumbs");
    expect(crumbs?.textContent).toContain("a");
  });

  it("goTo an empty/nonexistent submap path renders an empty canvas, not an error", () => {
    const instance = renderFlowgo(container, "node a hi 0 0\n");
    expect(() => instance.goTo("/nonexistent")).not.toThrow();
    expect(container.querySelectorAll(".fgi-box").length).toBe(0);
    expect(instance.path).toBe("/nonexistent");
  });

  it("respects an explicit initial path option", () => {
    const instance = renderFlowgo(container, NESTED, { path: "/a" });
    expect(instance.path).toBe("/a");
    expect(container.querySelector(".fgi-box")?.textContent).toBe("inside");
  });
});

describe("renderFlowgo: images", () => {
  it("resolves a relative image src against mediaBaseUrl", () => {
    renderFlowgo(container, "image i1 pic.png 0 0 100 100\n", { mediaBaseUrl: "https://example.com/media" });
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/media/pic.png");
  });

  it("leaves an absolute image src untouched even with mediaBaseUrl set", () => {
    renderFlowgo(container, "image i1 https://cdn.example.com/pic.png 0 0 100 100\n", {
      mediaBaseUrl: "https://example.com/media",
    });
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/pic.png");
  });

  it("leaves a data: URI image src untouched", () => {
    const dataUri = "data:image/png;base64,AAAA";
    renderFlowgo(container, `image i1 ${dataUri} 0 0 100 100\n`, { mediaBaseUrl: "https://example.com/media" });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(dataUri);
  });

  it("leaves image src as-is when no mediaBaseUrl is given", () => {
    renderFlowgo(container, "image i1 pic.png 0 0 100 100\n");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("pic.png");
  });
});

describe("renderFlowgo: instance lifecycle", () => {
  it("re-rendering into the same container replaces its contents rather than appending", () => {
    renderFlowgo(container, "node a first 0 0\n");
    renderFlowgo(container, "node b second 0 0\n");
    const boxes = container.querySelectorAll(".fgi-box");
    expect(boxes.length).toBe(1);
    expect(boxes[0]?.textContent).toBe("second");
  });

  it("destroy() clears the container", () => {
    const instance = renderFlowgo(container, "node a hi 0 0\n");
    instance.destroy();
    expect(container.innerHTML).toBe("");
  });

  it("injects exactly one shared stylesheet even across multiple instances", () => {
    renderFlowgo(container, "node a hi 0 0\n");
    const other = document.createElement("div");
    document.body.appendChild(other);
    renderFlowgo(other, "node b there 0 0\n");
    expect(document.querySelectorAll("#flowgo-inline-style").length).toBe(1);
  });
});
