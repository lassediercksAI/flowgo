// Pure(ish) DOM logic for rendering a ```flowgo code block, kept
// separate from main.ts's Plugin/registerMarkdownCodeBlockProcessor
// wiring so it can be unit-tested with jsdom (see ../test/render.test.ts)
// without needing to launch the real Obsidian app — which isn't
// possible in this repo's CI or sandboxes.
//
// Imports the flowgo renderer straight from source
// (../../src/render/inline.ts) rather than vendoring the
// `pnpm build:inline` IIFE bundle: esbuild (already required to build
// this plugin's main.js) happily bundles it directly, so there's no
// need to carry a second built copy of the same code around.
import { renderFlowgo, type FlowgoInlineInstance } from "../../src/render/inline.ts";

// Fixed height for the embed: the shared renderer's root element is
// `height: 100%`, which collapses to 0 unless an ancestor gives it an
// explicit height — Obsidian's code-block container is a plain flow
// element with no height of its own (same reason the plain HTML embed
// example in ../../README.md sets an explicit height on its container).
export const DEFAULT_EMBED_HEIGHT = "480px";

// Render `source` (.flowgo text) into `el`, replacing any existing
// contents. Read-only: no editing affordances beyond the renderer's
// built-in pan/zoom/drill-in. Never throws — a malformed or empty
// .flowgo block renders a small error message in place rather than
// breaking the rest of the note's reading-view render.
export function renderFlowgoBlock(el: HTMLElement, source: string): FlowgoInlineInstance | undefined {
  el.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "flowgo-embed";
  wrapper.style.width = "100%";
  wrapper.style.height = DEFAULT_EMBED_HEIGHT;
  el.appendChild(wrapper);

  try {
    return renderFlowgo(wrapper, source, { drillIn: true });
  } catch (err) {
    wrapper.innerHTML = "";
    wrapper.style.removeProperty("height");
    const pre = document.createElement("pre");
    pre.className = "flowgo-embed-error";
    pre.textContent = `flowgo: could not render this block\n${err instanceof Error ? err.message : String(err)}`;
    wrapper.appendChild(pre);
    return undefined;
  }
}
