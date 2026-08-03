// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateFlowgoEmbeds } from "../src/hydrate.js";

const toBase64 = (source: string): string => {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
};

describe("hydrateFlowgoEmbeds", () => {
  let renderFlowgo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    renderFlowgo = vi.fn();
    (window as unknown as { FlowgoInline: unknown }).FlowgoInline = { renderFlowgo };
    document.body.innerHTML = "";
  });

  afterEach(() => {
    delete (window as unknown as { FlowgoInline?: unknown }).FlowgoInline;
  });

  it("finds .flowgo-embed elements, decodes the source, and calls FlowgoInline.renderFlowgo", () => {
    document.body.innerHTML = `
      <div class="flowgo-embed" data-flowgo-source="${toBase64("box a 0 0 Hello")}"></div>
    `;

    const count = hydrateFlowgoEmbeds(document);

    expect(count).toBe(1);
    expect(renderFlowgo).toHaveBeenCalledTimes(1);
    const [container, source] = renderFlowgo.mock.calls[0]!;
    expect(container).toBeInstanceOf(HTMLElement);
    expect(container.className).toBe("flowgo-embed");
    expect(source).toBe("box a 0 0 Hello");
  });

  it("hydrates multiple embeds in one pass", () => {
    document.body.innerHTML = `
      <div class="flowgo-embed" data-flowgo-source="${toBase64("box a 0 0 One")}"></div>
      <p>not a flowgo embed</p>
      <div class="flowgo-embed" data-flowgo-source="${toBase64("box b 0 0 Two")}"></div>
    `;

    const count = hydrateFlowgoEmbeds(document);

    expect(count).toBe(2);
    expect(renderFlowgo).toHaveBeenCalledTimes(2);
  });

  it("marks elements as hydrated and skips them on a second call (idempotent)", () => {
    document.body.innerHTML = `
      <div class="flowgo-embed" data-flowgo-source="${toBase64("box a 0 0 Hello")}"></div>
    `;

    hydrateFlowgoEmbeds(document);
    const secondCount = hydrateFlowgoEmbeds(document);

    expect(secondCount).toBe(0);
    expect(renderFlowgo).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".flowgo-embed")?.hasAttribute("data-flowgo-hydrated")).toBe(true);
  });

  it("round-trips non-ASCII source through base64", () => {
    document.body.innerHTML = `
      <div class="flowgo-embed" data-flowgo-source="${toBase64("box a 0 0 Café 🎉 日本語")}"></div>
    `;

    hydrateFlowgoEmbeds(document);

    expect(renderFlowgo.mock.calls[0]![1]).toBe("box a 0 0 Café 🎉 日本語");
  });

  it("handles an embed with an empty source without throwing", () => {
    document.body.innerHTML = `<div class="flowgo-embed" data-flowgo-source=""></div>`;

    expect(() => hydrateFlowgoEmbeds(document)).not.toThrow();
    expect(renderFlowgo).toHaveBeenCalledWith(expect.any(HTMLElement), "");
  });

  it("does nothing and warns when window.FlowgoInline is not defined", () => {
    delete (window as unknown as { FlowgoInline?: unknown }).FlowgoInline;
    document.body.innerHTML = `
      <div class="flowgo-embed" data-flowgo-source="${toBase64("box a 0 0 Hello")}"></div>
    `;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const count = hydrateFlowgoEmbeds(document);

    expect(count).toBe(0);
    expect(renderFlowgo).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is a no-op when there are no .flowgo-embed elements", () => {
    document.body.innerHTML = "<p>nothing here</p>";
    expect(hydrateFlowgoEmbeds(document)).toBe(0);
  });
});
