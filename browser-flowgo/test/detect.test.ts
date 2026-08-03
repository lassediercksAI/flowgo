import { describe, it, expect } from "vitest";
import { detectFlowgoBlocks, looksLikeFlowgoSource, PROCESSED_ATTR } from "../src/detect";

const FLOWGO_SOURCE = "node a Start 0 0\nnode b Finish 240 0\nedge a b\n";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("looksLikeFlowgoSource", () => {
  it("recognizes real .flowgo directive syntax", () => {
    expect(looksLikeFlowgoSource(FLOWGO_SOURCE)).toBe(true);
  });

  it("rejects empty content", () => {
    expect(looksLikeFlowgoSource("")).toBe(false);
    expect(looksLikeFlowgoSource("   \n  \n")).toBe(false);
  });

  it("rejects ordinary code that happens to start a line with a directive-like word", () => {
    // "text" is a real directive keyword, but this isn't flowgo source —
    // every line must look like a directive, and this one has a line
    // that clearly doesn't.
    expect(looksLikeFlowgoSource('text = "hello"\nconsole.log(text)\n')).toBe(false);
  });

  it("rejects a lone version line with no actual content directive", () => {
    expect(looksLikeFlowgoSource("version 0.3.2\n")).toBe(false);
  });

  it("accepts version + node/edge directives together", () => {
    expect(looksLikeFlowgoSource(`version 0.3.2\n${FLOWGO_SOURCE}`)).toBe(true);
  });
});

describe("detectFlowgoBlocks", () => {
  it("matches a code block with a language-flowgo class", () => {
    setBody(`<pre><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>`);
    const found = detectFlowgoBlocks(document.body);
    expect(found).toHaveLength(1);
    expect(found[0]?.tagName).toBe("PRE");
  });

  it("matches lang-flowgo and is case-insensitive", () => {
    setBody(`<pre><code class="lang-FLOWGO">${FLOWGO_SOURCE}</code></pre>`);
    expect(detectFlowgoBlocks(document.body)).toHaveLength(1);
  });

  it("falls back to content-sniffing when there's no language class at all", () => {
    setBody(`<pre><code>${FLOWGO_SOURCE}</code></pre>`);
    expect(detectFlowgoBlocks(document.body)).toHaveLength(1);
  });

  it("does not match when a different language class is present, even if the content looks like flowgo", () => {
    // A site tagging the block as something else takes precedence —
    // don't second-guess an explicit language class.
    setBody(`<pre><code class="language-text">${FLOWGO_SOURCE}</code></pre>`);
    expect(detectFlowgoBlocks(document.body)).toHaveLength(0);
  });

  it("ignores an unrelated code block", () => {
    setBody('<pre><code class="language-js">console.log("hi");</code></pre>');
    expect(detectFlowgoBlocks(document.body)).toHaveLength(0);
  });

  it("ignores inline code spans (no enclosing <pre>)", () => {
    setBody(`<p>see <code class="language-flowgo">${FLOWGO_SOURCE}</code> inline</p>`);
    expect(detectFlowgoBlocks(document.body)).toHaveLength(0);
  });

  it("skips a block already marked processed", () => {
    setBody(`<pre ${PROCESSED_ATTR}="1"><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>`);
    expect(detectFlowgoBlocks(document.body)).toHaveLength(0);
  });

  it("finds multiple independent blocks on the page", () => {
    setBody(
      `<pre><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>` +
        '<pre><code class="language-js">1 + 1;</code></pre>' +
        `<pre><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>`,
    );
    expect(detectFlowgoBlocks(document.body)).toHaveLength(2);
  });

  it("also matches when called directly on a <code> element (MutationObserver added-node case)", () => {
    setBody(`<pre><code class="language-flowgo">${FLOWGO_SOURCE}</code></pre>`);
    const code = document.querySelector("code");
    if (!code) throw new Error("expected a code element");
    expect(detectFlowgoBlocks(code)).toHaveLength(1);
  });
});
