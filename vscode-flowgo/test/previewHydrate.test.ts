import { describe, expect, it, vi } from "vitest";
import { hydrateFlowgoBlocks, type RenderFn } from "../src/previewHydrate";

// Builds a fake preview DOM the way VS Code's Markdown preview does for a
// ```flowgo fenced block (and, for the "leave other languages alone"
// case, a ```js block too): markdown-it turns each fence into
// <pre><code class="language-<lang>">...</code></pre>.
const setPreviewHtml = (html: string): HTMLElement => {
  document.body.innerHTML = html;
  return document.body;
};

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("hydrateFlowgoBlocks", () => {
  it("replaces a flowgo code block with a rendered container", () => {
    const flowgoText = "box a\nbox b\na -> b";
    setPreviewHtml(`<pre><code class="language-flowgo">${escapeHtml(flowgoText)}</code></pre>`);

    const render: RenderFn = vi.fn((container, text) => {
      container.textContent = `rendered:${text}`;
      return { path: "/", goTo: () => {}, destroy: () => {} };
    });

    const count = hydrateFlowgoBlocks(document, render);

    expect(count).toBe(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(expect.any(HTMLElement), flowgoText);
    expect(document.querySelector("pre")).toBeNull();
    expect(document.querySelector("code.language-flowgo")).toBeNull();
    const rendered = document.querySelector(".flowgo-preview-root");
    expect(rendered).not.toBeNull();
    expect(rendered?.textContent).toBe(`rendered:${flowgoText}`);
  });

  it("leaves non-flowgo code blocks untouched", () => {
    setPreviewHtml(
      '<pre><code class="language-js">console.log("hi")</code></pre>' +
        '<pre><code class="language-flowgo">box a</code></pre>',
    );

    const render: RenderFn = vi.fn((container) => {
      container.textContent = "rendered";
    });

    const count = hydrateFlowgoBlocks(document, render);

    expect(count).toBe(1);
    expect(render).toHaveBeenCalledTimes(1);
    const jsBlock = document.querySelector("code.language-js");
    expect(jsBlock).not.toBeNull();
    expect(jsBlock?.textContent).toBe('console.log("hi")');
    expect(document.querySelectorAll(".flowgo-preview-root")).toHaveLength(1);
  });

  it("does not throw on malformed or empty flowgo text, and surfaces the error instead", () => {
    setPreviewHtml('<pre><code class="language-flowgo"></code></pre>');

    const render: RenderFn = vi.fn(() => {
      throw new Error("boom: malformed .flowgo");
    });

    expect(() => hydrateFlowgoBlocks(document, render)).not.toThrow();
    const count = hydrateFlowgoBlocks(document, render);
    // second call: the block from the first call is already marked
    // hydrated (attribute set before render is attempted), so nothing new
    // to do — asserts idempotency alongside the "doesn't throw" behavior.
    expect(count).toBe(0);

    // original <pre><code> block is left in place (render failed)...
    expect(document.querySelector("code.language-flowgo")).not.toBeNull();
    // ...with an inline error notice next to it.
    const notice = document.querySelector(".flowgo-preview-error");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("boom: malformed .flowgo");
  });

  it("does not re-hydrate a block that's already been hydrated", () => {
    setPreviewHtml('<pre><code class="language-flowgo">box a</code></pre>');
    const render: RenderFn = vi.fn((container) => {
      container.textContent = "rendered";
    });

    const first = hydrateFlowgoBlocks(document, render);
    const second = hydrateFlowgoBlocks(document, render);

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("returns 0 and renders nothing when there are no flowgo blocks", () => {
    setPreviewHtml("<p>just some regular markdown</p>");
    const render: RenderFn = vi.fn();

    const count = hydrateFlowgoBlocks(document, render);

    expect(count).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });
});
