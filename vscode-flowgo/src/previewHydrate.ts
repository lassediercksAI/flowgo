// Pure DOM-manipulation logic for hydrating rendered .flowgo maps into a
// VS Code Markdown preview webview. Deliberately has zero VS Code API
// surface (no `import * as vscode`) so it can be unit-tested with plain
// jsdom — see test/previewHydrate.test.ts — and so the same module can be
// bundled standalone as the actual script injected into the preview via
// the `markdown.previewScripts` contribution point (see bootstrap() below
// and vite.preview.config.ts).
//
// Read-only: this only ever touches the rendered *preview* DOM. VS Code's
// text editor (and the underlying Markdown source) is never modified.

export type RenderFn = (container: HTMLElement, flowgoText: string, opts?: Record<string, unknown>) => unknown;

const HYDRATED_ATTR = "data-flowgo-hydrated";
const CONTAINER_CLASS = "flowgo-preview-root";
const ERROR_CLASS = "flowgo-preview-error";

// Find every `<code class="language-flowgo">` block under `root` (a
// Document or a DOM subtree) that hasn't already been hydrated, and
// replace its containing element (the `<pre>`, if present — otherwise the
// `<code>` itself) with a live-rendered flowgo map produced by `render`
// (normally `window.FlowgoInline.renderFlowgo`, injected here so tests can pass
// a fake).
//
// Returns the number of blocks hydrated. Never throws: a block whose
// content fails to parse/render is left in place with an inline error
// note rather than aborting the whole pass, so one bad fence doesn't take
// out every other flowgo block (or the rest of the preview) with it.
export const hydrateFlowgoBlocks = (root: ParentNode, render: RenderFn): number => {
  let hydrated = 0;
  const blocks = root.querySelectorAll<HTMLElement>("code.language-flowgo");

  blocks.forEach((code) => {
    if (code.hasAttribute(HYDRATED_ATTR)) return;
    code.setAttribute(HYDRATED_ATTR, "true");

    const flowgoText = code.textContent ?? "";
    const host = (code.parentElement && code.parentElement.tagName === "PRE") ? code.parentElement : code;

    const container = document.createElement("div");
    container.className = CONTAINER_CLASS;
    container.style.height = "420px";
    container.style.width = "100%";

    try {
      render(container, flowgoText);
      host.replaceWith(container);
      hydrated += 1;
    } catch (err) {
      // Leave the original <pre>/<code> in place, but surface the
      // failure right below it instead of silently doing nothing —
      // easier to debug a malformed fence from the preview itself.
      const notice = document.createElement("div");
      notice.className = ERROR_CLASS;
      notice.textContent = `flowgo: failed to render (${err instanceof Error ? err.message : String(err)})`;
      host.after(notice);
    }
  });

  return hydrated;
};

// Entry point bundled by vite.preview.config.ts into media/preview.js and
// loaded via `markdown.previewScripts`. Not exercised by the unit tests
// (it reaches out to `window`/`document` globals VS Code's webview
// provides); the pure logic above is what's tested.
//
// Per VS Code's Markdown extension guide, contributed preview scripts run
// once when the preview document is first created; subsequent edits are
// applied as incremental DOM patches rather than a fresh script load, so
// re-hydration on `vscode.markdown.updateContent` is required to catch
// flowgo fences that are added/changed after the initial render (see
// https://code.visualstudio.com/api/extension-guides/markdown-extension
// and https://github.com/microsoft/vscode/issues/136255).
export const bootstrap = (): void => {
  const run = (): void => {
    // The vendored bundle (media/flowgo-inline.js, built from
    // ../src/render/inline.ts) exports `renderFlowgo`, not `render` — the
    // name actually defined by that source module, not the `FlowgoInline
    // .render(...)` shorthand used in its own top-of-file doc comment.
    const flowgoInline = (window as unknown as { FlowgoInline?: { renderFlowgo: RenderFn } }).FlowgoInline;
    if (!flowgoInline) return; // vendored bundle failed to load; nothing we can do
    hydrateFlowgoBlocks(document, flowgoInline.renderFlowgo);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }

  window.addEventListener("vscode.markdown.updateContent", run);
};
