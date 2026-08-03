# vscode-flowgo

VS Code extension that renders ```` ```flowgo ```` fenced code blocks as
live flowgo mind-maps inside VS Code's **built-in Markdown preview**.
Read-only: the preview pane shows a rendered map, but the Markdown source
in the text editor is completely untouched — there is no in-place editing,
no custom editor, no write-back to the file.

## How it works

VS Code's Markdown preview already turns a ` ```flowgo ` fence into
`<pre><code class="language-flowgo">...</code></pre>` in the preview HTML
(same as it does for any other language). Two contribution points in
`package.json` — [`markdown.previewScripts` and
`markdown.previewStyles`](https://code.visualstudio.com/api/extension-guides/markdown-extension#adding-scripts-and-styles-to-the-markdown-preview)
— let an extension inject plain `<script>`/`<style>` tags into that
preview webview, no custom `extendMarkdownIt` markdown-it plugin needed:

- `media/flowgo-inline.js` — a vendored copy of the repo's
  dependency-free `.flowgo` renderer bundle (`pnpm build:inline` at the
  repo root; see `../vite.inline.config.ts` and `../src/render/inline.ts`),
  exposing a global `FlowgoInline.renderFlowgo(container, flowgoText)`
  (that's the actual exported name in `../src/render/inline.ts` — its own
  top-of-file doc comment says `FlowgoInline.render(...)`, which doesn't
  match what the module exports; this extension calls the real one).
- `media/preview.js` — built from `src/previewHydrate.ts` /
  `src/previewEntry.ts`. On load it finds every
  `code.language-flowgo` element in the preview DOM, reads its text as the
  `.flowgo` source, and replaces its `<pre>` with a container rendered by
  `FlowgoInline.renderFlowgo(...)`. It also listens for the
  `vscode.markdown.updateContent` window event VS Code's Markdown preview
  fires on incremental content updates (previewScripts run once on
  initial preview load, not on every edit — see [the extension
  guide](https://code.visualstudio.com/api/extension-guides/markdown-extension)
  and [microsoft/vscode#136255](https://github.com/microsoft/vscode/issues/136255)),
  so newly-added or edited flowgo fences get hydrated too, not just the
  ones present when the preview first opened.
- `media/preview.css` — minor styling for the rendered container and for
  an inline error notice if a fence fails to render (a malformed block
  never throws past `hydrateFlowgoBlocks`; it's left as-is with a visible
  error instead of silently doing nothing or breaking the rest of the
  preview).

`src/extension.ts` is the extension's actual activation entry point and
is a near-no-op — all the real behavior above is declarative
(`contributes.markdown.*`) or lives in the plain DOM script, neither of
which needs the extension's `activate()` to run any wiring.

## Building

`media/flowgo-inline.js` and `media/preview.js` are generated, not
committed (see `.gitignore`) — regenerate them with:

```sh
cd vscode-flowgo
npm install
npm run build      # vendor:inline + build:preview + compile
```

`vendor:inline` runs `pnpm build:inline` **in the repo root** (requires
the root `pnpm install` to have been run first) and copies
`../dist-inline/flowgo-inline.js` into `media/flowgo-inline.js`.
`build:preview` bundles `src/previewEntry.ts` into `media/preview.js` via
`vite.preview.config.ts`. `compile` runs `tsc -p ./` for the extension
host entry (`src/extension.ts` → `out/extension.js`).

This package is self-contained (its own `package.json`/lockfile,
independent of the root `pnpm-workspace`, which doesn't exist — the repo
root is a single package) so `npm install` /`pnpm install` here doesn't
touch or get touched by the root frontend's install/build/CI.

## Testing

```sh
npm test
```

`test/previewHydrate.test.ts` runs the DOM-hydration logic
(`hydrateFlowgoBlocks` in `src/previewHydrate.ts`) under Vitest + jsdom
against a synthetic preview DOM, asserting: a `language-flowgo` block gets
replaced with a rendered container; other-language blocks are left
untouched; malformed/empty flowgo text doesn't throw (the failure is
surfaced as an inline notice instead); and re-running hydration on an
already-hydrated block is a no-op.

## What's verified vs. not

Verified: the hydration logic itself (unit tests above), the TypeScript
compile (`npm run compile` / `npm run typecheck`), and the
`markdown.previewScripts`/`previewStyles` contribution points and the
`vscode.markdown.updateContent` re-hydration behavior against VS Code's
own extension-guide docs and issue tracker.

**Not verified**: this extension has not been installed into a running
VS Code instance, and no real Markdown preview webview has been opened
against it — that isn't possible in the sandboxed environment this was
built in (no VS Code UI available). If something about the real preview
webview's DOM shape or CSP differs from what's assumed here, it hasn't
been caught by anything short of an actual install-and-open test.

**Not published**: this is not on the VS Code Marketplace. Publishing is
a separate, human-judgment step (picking a real publisher id, versioning,
marketplace listing copy, etc.) and is out of scope here.

## Scope

Read-only rendering only — no map editing from the preview, no custom
text editor, no writing back to the `.flowgo`/Markdown source. This
mirrors the read-only scope of the sibling Obsidian and remark/rehype
integrations for the same `.flowgo` fenced-block rendering feature.
