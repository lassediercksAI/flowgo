import { describe, it, expect, beforeEach } from "vitest";
import { renderBlock, revertBlock } from "../src/render";
import { PROCESSED_ATTR } from "../src/detect";

const FLOWGO_SOURCE = "node a Start 0 0\nnode b Finish 240 0\nedge a b\n";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderBlock", () => {
  it("renders the flowgo content into a sibling embed and hides the original block", () => {
    document.body.innerHTML = `<pre><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>`;
    const pre = document.querySelector("pre");
    if (!pre) throw new Error("expected a pre element");

    renderBlock(pre);

    expect(pre.hasAttribute(PROCESSED_ATTR)).toBe(true);
    expect(pre.style.display).toBe("none");

    const embed = pre.nextElementSibling;
    expect(embed).not.toBeNull();
    expect(embed?.className).toBe("flowgo-ext-embed");
    // The inline renderer builds a `.fgi-root` structure with the box
    // labels present as text somewhere inside it.
    expect(embed?.querySelector(".fgi-root")).not.toBeNull();
    expect(embed?.textContent).toContain("Start");
    expect(embed?.textContent).toContain("Finish");
  });

  it("does nothing if the block is already processed", () => {
    document.body.innerHTML = `<pre ${PROCESSED_ATTR}="1"><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>`;
    const pre = document.querySelector("pre");
    if (!pre) throw new Error("expected a pre element");
    renderBlock(pre);
    expect(pre.nextElementSibling).toBeNull();
  });

  it("shows an inline error instead of throwing on malformed flowgo source", () => {
    document.body.innerHTML = `<pre><code class="language-flowgo">this is not valid flowgo syntax at all !!!</code></pre>`;
    const pre = document.querySelector("pre");
    if (!pre) throw new Error("expected a pre element");
    expect(() => renderBlock(pre)).not.toThrow();
    const embed = pre.nextElementSibling;
    expect(embed?.textContent).toMatch(/couldn't render/i);
  });

  it("handles an empty flowgo block without throwing", () => {
    document.body.innerHTML = `<pre><code class="language-flowgo"></code></pre>`;
    const pre = document.querySelector("pre");
    if (!pre) throw new Error("expected a pre element");
    expect(() => renderBlock(pre)).not.toThrow();
  });
});

describe("revertBlock", () => {
  it("removes the embed and shows the original block again", () => {
    document.body.innerHTML = `<pre><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>`;
    const pre = document.querySelector("pre");
    if (!pre) throw new Error("expected a pre element");

    renderBlock(pre);
    expect(pre.nextElementSibling).not.toBeNull();

    revertBlock(pre);
    expect(pre.hasAttribute(PROCESSED_ATTR)).toBe(false);
    expect(pre.style.display).toBe("");
    expect(pre.nextElementSibling).toBeNull();
  });

  it("is a no-op on a block that was never rendered", () => {
    document.body.innerHTML = "<pre><code>plain code</code></pre>";
    const pre = document.querySelector("pre");
    if (!pre) throw new Error("expected a pre element");
    expect(() => revertBlock(pre)).not.toThrow();
  });
});
