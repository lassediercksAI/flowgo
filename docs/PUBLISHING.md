# Publishing the editor integrations

Prep state for brain#29a: everything below the "owner steps" lines is done
on this branch — manifests are complete, builds are reproducible from a
clean checkout, each package's own test suite passes, and packaging was
dry-run verified (`npm pack --dry-run`, `vsce package`, the browser zip
script). What remains is exactly the part that needs the owner's accounts.

Applies to: `remark-flowgo/`, `vscode-flowgo/`, `browser-flowgo/`,
`obsidian-flowgo/`, all at version **0.1.0**.

## Shared notes

- **Versioning.** release-please only manages the root Go app (`v0.3.x`
  tags). The four integrations are versioned manually in their own
  `package.json`/`manifest.json` and start at 0.1.0. Bump them by hand per
  release. The Obsidian release tag (`0.1.0`, no `v`) will not collide
  with the root `vX.Y.Z` tags. If integration releases become routine,
  add them as packages in `release-please-config.json`.
- **License.** The repo is AGPL-3.0-only. None of the four targets
  restricts copyleft licenses: npm accepts any license, the Chrome Web
  Store and Firefox AMO have no license restrictions for listed
  extensions (AMO explicitly supports open-source licensing; AGPL is on
  its standard license list), the VS Code Marketplace lets the publisher
  choose any license, and Obsidian community plugins only require that
  the repo carries a license the plugin actually complies with. The one
  practical AGPL consequence: anyone redistributing modified builds must
  publish source — that's on forks, not on us. `LICENSE` copies are now
  inside `remark-flowgo/` and `vscode-flowgo/` so the published artifacts
  carry the license text.
- **House rule:** conventional commits; version bumps are
  `chore(<integration>): release 0.1.x`.

---

## remark-flowgo → npm

**Status: ready.** `npm pack --dry-run` produces an 11-file, 26 kB
tarball (dist + vendor + LICENSE + README). The name `remark-flowgo` is
unclaimed on the registry (checked 2026-08-14). `prepublishOnly` runs the
tests. The vendored renderer bundle was stale and has been regenerated on
this branch — it now includes edge labels and the hex/triangle rendering
fixes from the current `src/render/inline.ts`.

Owner steps:

```sh
cd remark-flowgo
pnpm install
pnpm run build        # tsc + regenerate vendor/client bundle (needs root pnpm install once)
npm publish           # unscoped → public by default; add --access public if you like
```

Needs: npm account login (`npm login`), OTP if 2FA is on. Nothing else.

The README is the npm listing page — it is already written in the right
voice and its install section now shows `npm install remark-flowgo`.

---

## vscode-flowgo → VS Code Marketplace

**Status: ready** (pending publisher account). `vsce package` succeeds:
10 files, 26.5 KB — `out/extension.js`, the three `media/` files, icon,
README, LICENSE, nothing stray. Icon (128×128 PNG), `Visualization`
category, keywords, and SPDX license are in `package.json`.

Owner steps:

1. Create a publisher at <https://marketplace.visualstudio.com/manage>
   with id `flowgo` (that is what `package.json` `publisher` says — if
   the id is taken, pick another and update the field).
2. Create an Azure DevOps Personal Access Token with the
   **Marketplace → Manage** scope (any org; "All accessible
   organizations").
3. ```sh
   cd vscode-flowgo
   npm install && npm run build     # vendor:inline needs root pnpm install once
   npx @vscode/vsce login flowgo    # paste the PAT
   npx @vscode/vsce publish
   ```
   (Or `npx @vscode/vsce package` and upload the `.vsix` in the manage
   UI.)

Listing copy: the README is the listing body; `vsce` rewrites its
relative links to GitHub URLs because `repository` is set. The short
description comes from `package.json` `description`.

Optional asset: a 256×256 icon renders crisper on the marketplace than
the current 128×128; not required.

Also consider publishing the same `.vsix` to open-vsx.org (VSCodium,
Cursor et al.): `npx ovsx publish -p <open-vsx token>`. Free account,
same artifact.

---

## browser-flowgo → Chrome Web Store + Firefox AMO

**Status: needs screenshots**, otherwise ready. The manifest now carries
`browser_specific_settings.gecko` (id `flowgo-renderer@flowgo-map.com`,
min Firefox 109 — required for MV3 on AMO; Chrome logs an "unrecognized
key" note when loading unpacked but the store accepts it). One zip serves
both stores:

```sh
cd browser-flowgo
pnpm install
pnpm run package      # → browser-flowgo-0.1.0.zip (verified: 7 files)
```

### Chrome Web Store

1. Developer account at
   <https://chrome.google.com/webstore/devconsole> ($5 one-time fee).
2. New item → upload the zip.
3. Listing (drafts below), category "Workflow & Planning" or
   "Developer Tools".
4. Privacy tab: declare **no user data collected**; permission
   justifications —
   - `storage`: persists the single on/off toggle locally.
   - host access `<all_urls>`: the content script must see any page's
     code blocks to render flowgo fences in place; no data leaves the
     page.
   Broad host access routes the review to the slower queue — expect days
   to a couple of weeks.

Required assets still missing:
- **≥1 screenshot**, 1280×800 or 640×400 PNG/JPEG (no alpha). Suggested
  shots: a claude.ai or chatgpt.com response with a rendered map next to
  the raw fence; the popup toggle.
- Optional: small promo tile 440×280; marquee 1400×560.
- Store icon 128×128: already have `icon-128.png`.

### Firefox AMO

1. Firefox account → <https://addons.mozilla.org/developers/>.
2. Submit the same zip ("On this site" / listed channel).
3. Because `content.js`/`popup.js` are minified esbuild bundles, AMO
   **requires a source-code upload** with the submission: attach a zip of
   the repo (or the `browser-flowgo/` subtree plus `src/render/inline.ts`
   and the root `package.json`/lockfile it imports from) and build
   instructions: Node ≥ 18, pnpm 10, `pnpm install && pnpm run build`
   inside `browser-flowgo/`, output must byte-match `content.js`/
   `popup.js` in the submitted zip.
4. Screenshots: same captures as Chrome work; AMO is flexible on size.

Review is usually faster than Chrome's. `web-ext sign` also works for CI
later (needs AMO API key/secret), but the first listed submission is
easiest through the web UI.

### Listing copy (both stores)

Short (≤132 chars):

> Renders flowgo fenced code blocks as interactive mind maps on any page
> — including chatgpt.com and claude.ai. Read-only.

Long:

> When an AI assistant or a Markdown renderer outputs a \`\`\`flowgo code
> block, this extension renders it in place as a live flowgo mind map —
> pan, zoom, and drill into submaps, right where the code block sat.
>
> Works on any site that marks fenced code blocks the standard way
> (ChatGPT, Claude, GitHub, docs sites, static blogs). Streaming
> responses are handled: a block renders once, after it finishes
> arriving, not on every token.
>
> Read-only by design — viewing only, no editing, no account, no data
> collection. A single toolbar toggle turns rendering off and instantly
> reverts already-rendered blocks. The original code block is hidden,
> not removed, so page features attached to it (like copy buttons) keep
> working.
>
> flowgo is an open-source (AGPL) mind-mapping tool:
> https://github.com/lassediercks/flowgo

---

## obsidian-flowgo → Obsidian community plugins

**Status: needs one structural decision from the owner.** The plugin
itself is complete: `manifest.json` is valid, `versions.json` exists
(0.1.0 → minAppVersion 1.4.0), `pnpm build` produces `main.js`, tests
pass.

The catch: Obsidian's submission checks expect **`manifest.json` at the
root of the plugin's repository**, and a GitHub release per version with
`main.js`, `manifest.json`, `styles.css` attached as individual assets
(release tag = version string, exactly `0.1.0`). This repo is a monorepo,
so pick one:

- **Option A — manifest at monorepo root.** Copy
  `obsidian-flowgo/manifest.json` and `versions.json` to the repo root
  (CI or a just recipe keeps them in sync). Some monorepo plugins do
  this and pass review. Cost: two odd files at the flowgo repo root.
- **Option B — dedicated mirror repo** (e.g.
  `lassediercks/obsidian-flowgo`) containing the built plugin, populated
  by CI from this directory. Cleaner for the reviewer, standard shape.
  Cost: one more repo + a sync workflow.

Owner steps once decided:

1. Build: `cd obsidian-flowgo && pnpm install && pnpm build`.
2. Create a GitHub release tagged `0.1.0` (no `v` prefix) on whichever
   repo, attaching `main.js`, `manifest.json`, `styles.css` as assets.
3. Fork <https://github.com/obsidianmd/obsidian-releases>, add an entry
   to `community-plugins.json`:
   ```json
   {
     "id": "flowgo",
     "name": "flowgo",
     "author": "flowgo",
     "description": "Renders flowgo fenced code blocks as interactive mind maps in reading view.",
     "repo": "lassediercks/flowgo"
   }
   ```
   (`repo` = wherever the release lives; must match option A/B.)
4. Open the PR using their template; an automated validator runs first,
   then human review — historically weeks to months of queue.

Suggested `manifest.json` description tweak before submitting (the
review bot dislikes markdown/backticks in descriptions; keep it ≤250
chars, ending with a period):

> Renders flowgo fenced code blocks as interactive mind maps in reading
> view. Read-only: pan, zoom, and drill into submaps; editing a map
> still happens in the flowgo app.

No icon asset is needed — Obsidian community plugins don't have store
icons; the listing is name + author + description + repo README.

`isDesktopOnly` is `true` out of caution (pointer-event pan untested on
mobile). Fine for a first release; flipping it later after a real
mobile test is a normal follow-up release.
