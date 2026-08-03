# obsidian-flowgo

An [Obsidian](https://obsidian.md) plugin that renders ` ```flowgo ` fenced
code blocks as [flowgo](https://github.com/lassediercks/flowgo) mind-maps
in reading view / preview, using the project's shared read-only renderer
(`../src/render/inline.ts`) — the same one the VS Code extension and the
remark/rehype plugin (brain#216) render against.

**Read-only.** This plugin does not add any editing UI. While a note is
in edit mode / Live Preview, Obsidian shows the raw fenced code text —
that's normal default behavior for any code-block language without a
CodeMirror extension registered, and is intentional here: editing a
`.flowgo` map still requires the flowgo app itself. Only *reading view*
gets the rendered map, with the renderer's built-in pan (drag) and zoom
(wheel), plus submap drill-in if the map has one.

## Example

````markdown
```flowgo
box b1 "Project" 120 100
box b2 "Notes"   320 100
edge b1:r b2:l
anchor b1
```
````

## Installing (manual, not in the community plugin directory yet)

This plugin is **not published to Obsidian's community plugin
directory** — submitting it there is a separate step involving human
review and is out of scope for this change. To try it in a real vault:

```sh
cd obsidian-flowgo
pnpm install
pnpm build       # writes main.js next to manifest.json
```

Then copy `manifest.json`, `main.js`, and `styles.css` into
`<your-vault>/.obsidian/plugins/flowgo/`, and enable "flowgo" under
Settings → Community plugins → Installed plugins (you may need to
disable Safe Mode / community plugins restriction first).

## Development

```sh
cd obsidian-flowgo
pnpm install
pnpm dev         # esbuild --watch, writes main.js on change
pnpm test        # vitest + jsdom
```

`main.ts` only wires `registerMarkdownCodeBlockProcessor("flowgo", ...)`
to `src/render.ts`'s `renderFlowgoBlock(el, source)`, which is the part
that actually calls the shared renderer. That split exists so
`test/render.test.ts` can exercise the real rendering logic with jsdom's
DOM without needing to launch the actual Obsidian app (not possible in
this repo's CI or in the sandbox this plugin was originally built in —
see the note below).

`src/render.ts` imports `../../src/render/inline.ts` directly (a
relative import across the top-level directory boundary) rather than
vendoring a copy of the `pnpm build:inline` IIFE bundle: esbuild, which
this plugin already needs to produce `main.js`, bundles that source file
just as happily as it bundles `main.ts` itself, so there's no reason to
carry two built copies of the same renderer around.

## What was and wasn't verified

Verified:
- `pnpm test` (vitest + jsdom) passes — see `test/render.test.ts`. It
  asserts boxes/labels appear in the rendered DOM, that rendering an
  empty or malformed `.flowgo` string doesn't throw (a malformed block
  renders a small inline error instead of breaking the rest of the
  note), and that calling `renderFlowgoBlock` twice on the same
  container replaces its contents rather than appending.
- `pnpm build` (esbuild) produces `main.js` without errors.

Not verified (not possible in this sandboxed environment): actually
installing this into a real Obsidian vault and confirming the block
renders, pans, zooms, and drills into submaps correctly in the live
app. `isDesktopOnly` is set to `true` in `manifest.json` out of caution
— the shared renderer uses pointer events (not just mouse events) for
pan, which likely works fine in Obsidian's mobile WebView too, but that
was never actually tried on a mobile device, so the safer default was
chosen.
