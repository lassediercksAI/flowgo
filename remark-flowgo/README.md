# remark-flowgo

A [remark](https://github.com/remarkjs/remark) plugin that finds
` ```flowgo ` fenced code blocks in Markdown/MDX and turns them into a
live, read-only [flowgo](https://github.com/lassediercks/flowgo) map
render, wherever a remark/rehype pipeline runs: Next.js MDX, Astro,
Docusaurus, Gatsby, 11ty, or any other unified-based static site
pipeline.

No in-place editing — this is the same read-only rendering scope as the
Obsidian plugin and VS Code extension built alongside this package (see
brain task #216).

## The trade-off this package makes, up front

remark/rehype pipelines run at **build time in plain Node** — there is
no DOM. flowgo's shared renderer
([`src/render/inline.ts`](../src/render/inline.ts) in the main repo,
built as `FlowgoInline.renderFlowgo(container, text)` by `pnpm
build:inline`) is DOM-based: it creates real `HTMLElement`/SVG nodes and
needs a browser (or jsdom) to run.

That leaves two options for a build-time plugin:

- **(a) Client-side hydration (what this package does):** the remark
  plugin swaps each ` ```flowgo ` block for a
  `<div class="flowgo-embed" data-flowgo-source="...">` placeholder (the
  source, base64-encoded so it survives being dropped into an HTML
  attribute verbatim). A small bootstrap script — the vendored
  `flowgo-inline.js` bundle plus a thin hydration wrapper, concatenated
  into one file — runs once per page load, finds every `.flowgo-embed`
  div, and calls `FlowgoInline.renderFlowgo` on it. One `<script>` tag,
  no headless browser at build time, no build-time dependency on the
  DOM-only renderer.
- **(b) Server-side prerendering to static SVG/HTML** via jsdom at build
  time, producing a script-free embed. Heavier (a jsdom instance per
  build, per flowgo block) and more fragile (jsdom's SVG/layout support
  is partial, and flowgo's renderer leans on real layout for
  `offsetWidth`/`offsetHeight` when drawing edges — see
  `renderMap()`'s edge-drawing loop in `inline.ts`). Not attempted here.

This package only implements (a). The trade-off: a flowgo block renders
as inert placeholder markup until the bootstrap script runs client-side
(no map without JS; a `<noscript>` fallback or server-rendered
placeholder text would be a reasonable follow-up if that matters for a
given site).

## What this plugin does NOT do

Convert flowgo source into anything itself — no rendering happens at
build time. It only rewrites the mdast tree so the eventual HTML output
contains a placeholder div, using `data.hName`/`hProperties` (the
[mdast-util-to-hast](https://github.com/syntax-tree/mdast-util-to-hast)
convention for "this node should become a specific hast element").
Because of that, **no `allowDangerousHtml`/`rehype-raw` is needed** —
there's no raw HTML string in the pipeline at any point, just a plain
element description that `remark-rehype` turns into real hast, same as
any other node.

## Install

This package is not published to the npm registry (same situation as
the root `@flowgo/editor` package — see the main repo's README). Install
it from the git repo, e.g. with pnpm/npm's git-dependency syntax
pointing at this subdirectory, or vendor it into your project directly:

```jsonc
// package.json
"dependencies": {
  "remark-flowgo": "github:lassediercks/flowgo#path:/remark-flowgo"
}
```

(`path:` subdirectory git deps require pnpm ≥ 8 / npm ≥ 9. If your
package manager doesn't support that syntax, clone the repo and use a
`file:` reference to `remark-flowgo/` instead, the same way the root
repo's own `dist-inline` consumers do.)

## Usage

### 1. Wire the remark plugin into your pipeline

```js
import remarkFlowgo from "remark-flowgo";

// Next.js (next.config.mjs, @next/mdx):
const withMDX = createMDX({
  options: {
    remarkPlugins: [remarkFlowgo],
  },
});

// Astro (astro.config.mjs):
export default defineConfig({
  markdown: {
    remarkPlugins: [remarkFlowgo],
  },
});

// Docusaurus (docusaurus.config.js), Gatsby (gatsby-config.js under
// gatsby-transformer-remark/gatsby-plugin-mdx options), 11ty (via
// @11ty/eleventy-plugin-mdx or a markdown-it/remark bridge): same idea
// — add `remarkFlowgo` (optionally called with options, see below) to
// whatever array of remark plugins your framework's config exposes.
```

Options:

```ts
remarkFlowgo({
  // Class name on the placeholder <div>. Defaults to "flowgo-embed".
  // Only change this if you also point the hydration script (or your
  // own selector) at the same class.
  className: "flowgo-embed",
});
```

### 2. Include the hydration script once per page

The simplest option — copy the prebuilt, self-contained bundle into your
site's static assets and include it once, anywhere after the page's
`.flowgo-embed` divs (or with `defer`):

```
cp node_modules/remark-flowgo/dist/flowgo-remark-client.js public/flowgo-remark-client.js
```

```html
<script src="/flowgo-remark-client.js" defer></script>
```

That single file already contains the vendored `flowgo-inline.js`
renderer — nothing else to load. It hydrates on `DOMContentLoaded` (or
immediately if the page has already loaded), and exposes
`window.flowgoRemark.hydrate()` so an SPA-style client-side route change
that injects new `.flowgo-embed` markup without a full page load can
re-hydrate on demand.

Alternatively, if your site already loads `flowgo-inline.js` some other
way (e.g. bundled by your own build), import just the hydration logic
and call it yourself:

```js
import { hydrateFlowgoEmbeds } from "remark-flowgo/hydrate";

// after window.FlowgoInline is defined and the DOM is ready:
hydrateFlowgoEmbeds();
```

## Regenerating the vendored renderer

`vendor/flowgo-inline.js` and `dist/flowgo-remark-client.js` are
generated, committed files (this package isn't published anywhere that
could run a build step for you, so a consumer installing straight from
git needs working artifacts already in place). Regenerate them whenever
`src/render/inline.ts` changes upstream:

```
pnpm run build         # full build: tsc + regenerate vendor/client bundle
pnpm run build:vendor   # just the vendor copy + client bundle, skip tsc
```

Both run `pnpm run build:inline` at the repo root (needs the root
package's devDependencies installed — `pnpm install` there first) and
copy `dist-inline/flowgo-inline.js` in. Set `SKIP_VENDOR_BUILD=1` to
skip that step and just re-copy/re-bundle from whatever's already at
`../dist-inline/flowgo-inline.js`.

## Development

```
pnpm install
pnpm run test        # vitest — plugin output + hydration DOM logic
pnpm run typecheck
pnpm run build        # tsc + vendor/client bundle regeneration
node scripts/sanity-check.mjs   # process fixtures/sample.md, print the HTML
```

## What's verified vs. not

Verified:

- `test/remark-flowgo.test.ts` runs a real
  `unified().use(remarkParse).use(remarkFlowgo).use(remarkRehype).use(rehypeStringify)`
  pipeline against fixtures covering: a normal flowgo block, an empty
  flowgo block, other fenced blocks (` ```js `, no-language) left
  untouched, multiple flowgo blocks in one document, a custom
  `className` option, and non-ASCII source round-tripping through
  base64.
- `test/hydrate.test.ts` runs the DOM-hydration logic under jsdom
  independent of remark/rehype: finds `.flowgo-embed` elements, decodes
  `data-flowgo-source`, calls a mocked `FlowgoInline.renderFlowgo`,
  confirms idempotency (a second hydration pass skips already-hydrated
  elements) and graceful handling of a missing `FlowgoInline` global or
  an empty source.
- `scripts/sanity-check.mjs` processes `fixtures/sample.md` through the
  built plugin and prints the actual HTML; manually eyeballed to confirm
  the placeholder divs, encoded source, and untouched surrounding
  content all look right.
- `pnpm run build` end-to-end, including running the root repo's `pnpm
  build:inline` and producing a working `dist/flowgo-remark-client.js`.

**Not verified:** this plugin has not been run inside an actual Next.js,
Astro, Docusaurus, or Gatsby project in this environment — no such site
was available to test against here. The framework wiring above
(`remarkPlugins: [remarkFlowgo]`) matches each framework's documented
remark-plugin API, and the underlying mechanism (a standalone
`unified()` pipeline) is exactly what those frameworks run internally,
but the specific config surface of each framework has not been
exercised end-to-end. If you wire this into a real site and something
doesn't line up, that integration point is the first place to look.
