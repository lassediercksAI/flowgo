// Renders a detected flowgo block in place: the original <pre> is
// hidden (not removed — cheap and exact to undo when the toggle in
// the popup turns rendering off, and it preserves whatever the host
// page attached to that element, e.g. a "copy" button) and a sibling
// container is inserted right after it and handed to the shared
// read-only inline renderer.
import { renderFlowgo } from "../../src/render/inline.ts";
import { PROCESSED_ATTR } from "./detect.ts";

const EMBED_CLASS = "flowgo-ext-embed";

export function renderBlock(container: HTMLElement): void {
  if (container.hasAttribute(PROCESSED_ATTR)) return;
  const code = container.querySelector("code") ?? container;
  const source = code.textContent ?? "";

  const wrapper = document.createElement("div");
  wrapper.className = EMBED_CLASS;
  wrapper.style.cssText =
    "all: initial; display: block; position: relative; width: 100%; height: 320px; margin: 0.5em 0; " +
    "border: 1px solid #ddd; border-radius: 6px; overflow: hidden; font-family: -apple-system, sans-serif;";

  container.insertAdjacentElement("afterend", wrapper);
  container.style.display = "none";
  container.setAttribute(PROCESSED_ATTR, "1");

  try {
    renderFlowgo(wrapper, source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    wrapper.textContent = `flowgo: couldn't render this block (${message})`;
    wrapper.style.cssText += "padding: 8px; color: #900; font: 12px monospace; height: auto;";
  }
}

// Undoes renderBlock: removes the rendered embed and shows the
// original code block again. Used when the extension is toggled off.
export function revertBlock(container: HTMLElement): void {
  if (!container.hasAttribute(PROCESSED_ATTR)) return;
  const next = container.nextElementSibling;
  if (next && next.classList.contains(EMBED_CLASS)) next.remove();
  container.style.display = "";
  container.removeAttribute(PROCESSED_ATTR);
}
