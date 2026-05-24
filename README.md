# flowgo

A tiny mind-map / flowchart editor that round-trips between a browser GUI and a
plain-text `.flowgo` file. Every change in the GUI rewrites the file, and the
file is the source of truth — you can hand-edit it, version-control it, or
generate it from another tool.

> **License:** [AGPL-3.0](LICENSE). The core editor and MCP server are AGPL —
> use, modify, and self-host freely. Network use of a modified version
> obligates you to share the source under the same license.
>
> The hosted collaboration / sharing service at **flowgo-map.com** is a
> separate proprietary product running on top of this core. It is not part of
> the AGPL release.

## Try it

The path of least resistance, in order:

**1. In your browser, no install:** [flowgo-map.com](https://flowgo-map.com)

**2. On macOS / Linux via Homebrew:**

```
brew install lassediercks/flowgo/flowgo
flowgo new
```

The tap lives at [lassediercks/homebrew-flowgo](https://github.com/lassediercks/homebrew-flowgo)
and tracks the latest release. `brew upgrade flowgo` pulls new versions.

**3. On your machine, one command:**

```
go install github.com/lassediercks/flowgo@latest
flowgo new
```

`flowgo new` mints a `<random_name>.flowgo` file in the current directory and
opens it in your browser. The in-app help (`?` button, top-right) covers every
keybind and gesture.

To open an existing file:

```
flowgo mindmap.flowgo
```

The binary starts an HTTP server on `127.0.0.1:54041` (or a fallback port),
prints the URL, and opens your browser. If the file doesn't exist it's created
with one seed box.

---

## Contributing

Everything below is for working on flowgo itself.

### Local dev loop

```
just dev
```

Runs `vite build --watch` for the frontend and re-runs `go run` whenever any
`*.go` file or `dist/index.html` changes. Requires `pnpm` and `go`. Ctrl+C
tears both processes down cleanly.

Other recipes:

- `just build` — frontend bundle + `./flowgo` binary
- `just test` — vitest + `go test ./...`
- `just typecheck` — `tsc --noEmit`

### File format

Plain UTF-8 text, one directive per line, `#` for comments.

```
# optional map header; defaults to "/" if omitted
map /

box    <id> <label> <x> <y> [sides] [palette] [font] [rotation]
edge   <id>[:<handle>] <id>[:<handle>]
text   <id> <label> <x> <y> [palette] [font]
line   <id> <x1> <y1> <x2> <y2>
stroke <id> <x>,<y> <x>,<y> …
anchor <id>
```

- `id` is alphanumeric; unique within its map.
- `label` is a bare word or `"quoted string"` (escapes: `\"`, `\\`, `\n`).
- `<handle>` is one of `t`, `r`, `b`, `l`, `tl`, `tr`, `bl`, `br` — a side or
  corner of the box. Omit to let the renderer auto-pick the nearest handle.
- `map <path>` switches the current map. Paths look like `/`, `/b1`, `/b1/c2`.
  Each path corresponds to "the inside of" the box at that path.
- `anchor <id>` marks one box per map as the recenter target. At most one per
  map; the parser/serializer enforce the invariant.

#### Example

```
box b1 "Project" 120 100
box b2 "Notes"   320 100
edge b1:r b2:l
anchor b1

map /b1
box c1 "Goals"       100 100
box c2 "Open issues" 280 100
edge c1 c2

map /b1/c2
box d1 "Bug #42" 100 100
```

Files without any `map` directive parse as a single root map — fully
backwards-compatible with the flat form.

### MCP (AI integration)

`flowgo <file>` also serves a [Model Context Protocol](https://spec.modelcontextprotocol.io)
endpoint at `/mcp` on the same port as the GUI. Point any MCP client (Claude
Desktop, Cursor, etc.) at:

```
http://127.0.0.1:<port>/mcp
```

The port is printed at startup next to `MCP:`. Both the GUI and MCP share the
same file mutex, so AI edits and GUI edits coexist safely.

Available tools:

- `get_state` — read the full graph
- `set_state` — overwrite the full graph
- `add_box`, `update_box`, `delete_box`
- `add_edge`, `delete_edge`
- `add_text`, `add_line`

All tools take an optional `path` (defaults to `/`) so AI can target submaps.
The transport is JSON-RPC 2.0 over POST (streamable-HTTP, simple form — no
sessions or SSE).

### Releases

Releases are managed by [release-please](https://github.com/googleapis/release-please).
Push commits to `main` using
[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`feat!:` for breaking changes, etc.) and the workflow will open a "release-PR".
Merging that PR tags a new version, creates a GitHub release, and attaches
prebuilt binaries for `linux/{amd64,arm64}`, `darwin/{amd64,arm64}`, and
`windows/amd64`.

Versioning policy (configured in `release-please-config.json`):

- Tags are plain semver (`0.0.1`, `0.0.2`, …) — no `v` prefix.
- We're in the pre-1.0 phase: `bump-patch-for-minor-pre-major` makes regular
  `feat:` commits bump the patch (so we stay in `0.0.*`); breaking changes
  (`feat!:` / `BREAKING CHANGE:`) bump the minor (`0.0.* → 0.1.0`).

The version baked into the release binaries is set via
`-ldflags "-X main.version=<tag>"` and is shown by `flowgo version`.
