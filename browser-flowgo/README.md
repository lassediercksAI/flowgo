# browser-flowgo

A Chrome/Firefox extension that renders ` ```flowgo ` fenced code blocks
in-place on any page — including chatgpt.com and claude.ai, where an agent's
raw text output would otherwise just sit there as plain text (see
[the eval harness](../eval/README.md) for measuring how often a model reaches
for flowgo vs. a static mermaid block in the first place — this extension is
what makes flowgo output actually visible even when an agent can't call the
`create_map` tool on a given surface).

Read-only: view, pan, and zoom the rendered map. No editing, no auth, no
collab — see brain#217's scope.

## How it works

A content script scans the page for fenced code blocks and matches them two
ways:

1. **Primary:** a `language-flowgo` (or `lang-flowgo`) class on the `<code>`
   element — what any GFM-conventional Markdown renderer (remark/rehype,
   markdown-it, ChatGPT's and Claude's own renderers) emits from a
   ` ```flowgo ` fence, even though no syntax highlighter actually knows the
   "flowgo" language.
2. **Fallback:** content-sniffing against the real `.flowgo` directive
   grammar, for the rare site that strips unrecognized language classes.

Each match gets its `<pre>` hidden (not removed — cheap to undo, and it
preserves whatever the host page attached to that element, e.g. a copy
button) and a sibling container inserted right after it, rendered via the
repo's shared read-only inline renderer (`../src/render/inline.ts`).

chatgpt.com and claude.ai stream a response in token-by-token, repeatedly
re-rendering the message DOM while it's still arriving. A `MutationObserver`
watches for new/changed content and (re)schedules each candidate block on a
400ms "gone quiet?" debounce, reset on every further mutation, so a
still-streaming block isn't parsed and rendered over and over — it renders
once, after the stream settles.

## Toggle

The toolbar popup (`popup.html`) has a single on/off checkbox, persisted via
`storage.local` (works identically against Chrome's callback-turned-Promise
`chrome.storage.local` and Firefox's Promise-based `browser.storage.local`).
Turning it off immediately reverts every already-rendered block on open tabs
(via a `storage.onChanged` listener) and stops new pages from rendering
until it's turned back on.

## Building

```
pnpm install
pnpm run build   # bundles src/content.ts -> content.js, src/popup.ts -> popup.js
```

`content.js`/`popup.js` are gitignored build output — after `pnpm run build`,
this directory (`browser-flowgo/`) is itself a loadable unpacked extension:

- **Chrome:** `chrome://extensions` → enable Developer mode → "Load unpacked"
  → select this directory.
- **Firefox:** `about:debugging#/runtime/this-firefox` → "Load Temporary
  Add-on…" → select `manifest.json` in this directory. (Temporary — Firefox
  unloads it on browser restart; a permanent install needs signing, out of
  scope here.)

## Testing

```
pnpm test        # vitest + jsdom: detection, rendering, settings
pnpm typecheck
```

The block-detection, rendering, and settings logic (`src/detect.ts`,
`src/render.ts`, `src/settings.ts`) are plain, jsdom-testable modules —
`src/content.ts` is a thin wiring layer over them (MutationObserver +
per-block debounce), kept deliberately free of logic worth unit-testing on
its own.

Beyond the unit suite, this was verified with a real headed Chromium
instance (via `playwright-core`, already available in this environment) —
loaded as an actual unpacked extension against a static HTML fixture with a
` ```flowgo ` block and an unrelated ` ```js ` block, confirming: the flowgo
block renders as a live interactive map (screenshot-verified), the JS block
is left untouched, and the popup's on/off toggle correctly reverts an
already-rendered block on an open tab, blocks rendering on a freshly loaded
page while disabled, and resumes rendering on new pages once re-enabled.

**Not verified:** actually installed against a live chatgpt.com or claude.ai
session (this sandbox has no way to authenticate into either) — the
streaming-debounce behavior for a chat UI's specific DOM update pattern is
inferred from a generic MutationObserver test page, not observed against the
real site. Not published to the Chrome Web Store or Firefox Add-ons (a
separate, human-judgment step — signing, review, listing copy — out of
scope here).
