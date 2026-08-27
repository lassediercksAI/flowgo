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

// An auto-sized box's containing block, .fgi-layer, is absolutely
// positioned with no width and nothing in normal flow (box children
// are themselves position: absolute, so they don't contribute to its
// size) — its shrink-to-fit computation sees zero available width. A
// plain `textContent` assertion can't see this: the words are all
// still there, only broken across lines, so it reads identical either
// way. What actually regressed was which line each word landed on,
// i.e. the rendered line count for a label with no explicit break.
//
// jsdom has no layout engine (offsetWidth/offsetHeight are always 0 —
// see label-clamp.test.ts's stub), so there is no offsetHeight/lineH
// division to read a real drawn-line-count off of the way the
// website's e2e wrappedLabels() helper does in an actual browser
// (tests/e2e/features/support/marketing.ts). What jsdom *does*
// resolve correctly is the CSS cascade — getComputedStyle on a
// rendered .fgi-box reports the real white-space/word-break the
// browser will use, matched through the real class list by the real
// injected stylesheet, not a hand-copied guess of it.
//
// So this drives a small, standard greedy line-breaker (word-wrap at
// spaces; word-break: break-word additionally splits a word that
// alone still doesn't fit) off those real cascaded values, against a
// plain character budget standing in for "how many characters of
// width the box has to work with" — which is the exact quantity that
// collapsed to ~1 in the bug (shrink-to-fit resolving against a
// zero-width containing block). white-space: pre never wraps except
// at an authored "\n", regardless of that budget; pre-wrap +
// break-word wraps at (and inside) words once the budget gets narrow.
// That is precisely the mechanism the fix changes for unsized boxes.
const countWrappedLines = (
  text: string,
  budget: number,
  whiteSpace: string,
  wordBreak: string,
): number => {
  const paragraphs = text.split("\n");
  if (whiteSpace === "pre") return paragraphs.length;

  let lines = 0;
  for (const para of paragraphs) {
    const words = para.length > 0 ? para.split(" ") : [""];
    let col = 0;
    let lineHasContent = false;
    for (let word of words) {
      while (wordBreak === "break-word" && word.length > budget && budget > 0) {
        if (lineHasContent) {
          lines += 1;
          col = 0;
          lineHasContent = false;
        }
        lines += 1; // the budget-sized chunk sliced off below
        word = word.slice(budget);
      }
      const need = word.length + (lineHasContent ? 1 : 0);
      if (lineHasContent && col + need > budget) {
        lines += 1;
        col = word.length;
      } else {
        col += need;
        lineHasContent = true;
      }
    }
    lines += 1; // the paragraph's trailing (or only) line
  }
  return lines;
};

const computedOf = (el: Element): { whiteSpace: string; wordBreak: string } => {
  const cs = getComputedStyle(el);
  return { whiteSpace: cs.whiteSpace, wordBreak: cs.wordBreak };
};

describe("renderFlowgo: auto-sized box label wrapping (regression)", () => {
  it("sanity check: the simulator itself wraps pre-wrap + break-word onto multiple lines at a narrow budget", () => {
    // Guards against the regression test below passing vacuously
    // because countWrappedLines always returns 1 no matter what it's
    // fed — this is the pre-fix behaviour (bug), asserted directly.
    expect(countWrappedLines("Editor (browser)", 3, "pre-wrap", "break-word")).toBeGreaterThan(1);
  });

  it("an auto-sized box's label renders on one line at any container width, using the box's real cascaded CSS", () => {
    renderFlowgo(container, 'node a "Editor (browser)" 0 0\n');
    const box = container.querySelector(".fgi-box")!;
    expect(box.classList.contains("fgi-sized")).toBe(false);
    expect(box.textContent).toBe("Editor (browser)");
    const { whiteSpace, wordBreak } = computedOf(box);
    // Exercise a spread of budgets down to and including the width
    // that collapsed every hero box to the min-width: 80px floor in
    // the reported bug (a handful of characters at 14px/16px type).
    for (const budget of [1, 2, 3, 5, 8, 40]) {
      expect(
        countWrappedLines(box.textContent ?? "", budget, whiteSpace, wordBreak),
        `budget=${budget}`,
      ).toBe(1);
    }
  });

  it("an explicit line break in the label still renders as its own line, at any width", () => {
    renderFlowgo(container, 'node a "first\\nsecond" 0 0\n');
    const box = container.querySelector(".fgi-box")!;
    expect(box.textContent).toBe("first\nsecond");
    const { whiteSpace, wordBreak } = computedOf(box);
    // Two authored lines stay two lines regardless of the (irrelevant,
    // for white-space: pre) budget — an editable Shift+Enter break is
    // content, not a wrapping artefact the fix should suppress.
    for (const budget of [1, 40]) {
      expect(countWrappedLines(box.textContent ?? "", budget, whiteSpace, wordBreak)).toBe(2);
    }
  });

  it("a fixed-frame box (special shape) still wraps its label within its frame", () => {
    renderFlowgo(container, 'node a "a long label that needs to wrap" 0 0\nnodeshape a 1\n');
    const box = container.querySelector(".fgi-box")!;
    expect(box.classList.contains("fgi-sized")).toBe(true);
    const { whiteSpace, wordBreak } = computedOf(box);
    expect(whiteSpace).toBe("pre-wrap");
    expect(wordBreak).toBe("break-word");
    // With a real fixed frame the label is meant to wrap to fit it —
    // unlike the unsized case above, more than one line here is
    // correct, not a regression.
    expect(countWrappedLines(box.textContent ?? "", 6, whiteSpace, wordBreak)).toBeGreaterThan(1);
  });
});
