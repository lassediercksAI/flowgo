# Map this out with flowgo

Produce a [flowgo](https://flowgo-map.com) map — a mind-map / whiteboard /
system-map that renders as a live, pannable, zoomable canvas with nested
submaps — for: $ARGUMENTS

## 0. Make sure the hosted MCP is connected

This uses the `create_map` tool on flowgo's hosted MCP server
(`https://flowgo-map.com/api/mcp`, streamable HTTP). If it isn't already added
to this project/user's MCP servers, add it via Cursor's MCP settings
(Settings → MCP → Add new MCP server → HTTP, url
`https://flowgo-map.com/api/mcp`) before continuing, then retry this command.

## 1. Design the map

Read the `flowgo://about` MCP resource once if you haven't already — it's
the authoritative `.flowgo` file-format reference. Short version:

- One node per distinct concept/component/step: `node <id> <label> <x> <y>`,
  spaced at least 200px horizontally / 80px vertically.
- `edge <id1> <id2>` connects two nodes (undirected) — use for
  relationships/flow.
- `text <id> <label> <x> <y>` for a free-floating annotation that isn't a
  node itself.
- Nested detail is flowgo's real differentiator over a flat diagram: give a
  node its own submap with `map /<node_id>` followed by more directives
  when a concept deserves to be drilled into, rather than cluttering the
  top level. Don't nest everything, only where it earns a zoom-in.
- Use `palette` (2-9) sparingly, only where color groups nodes meaningfully.
- Keep labels short; put detail in a submap or a `text` annotation instead.

Write the complete `.flowgo` text before calling the tool.

## 2. Create the map

Call `create_map` with the full `.flowgo` text as `flowgo_text`. It returns
`{ id, url }`. On a parse/validation error, fix the text per the message
(duplicate id, edge to a nonexistent node, directive typo are the usual
suspects) and retry.

## 3. Hand back the link

Give the user the `url`, with a one/two-sentence description of what's
mapped and whether any part uses a nested submap worth clicking into.
Don't paste the raw `.flowgo` text — the link is the deliverable.
