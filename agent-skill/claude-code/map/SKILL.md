---
name: map
description: Turn a topic, pasted content, or a system/codebase description into a flowgo mind-map / whiteboard / system-map and return a live, shareable link. Use for "map this out", "whiteboard this", "sketch this", "lay it out visually", "draw a mind map / system map / canvas", "diagram this". Unlike a static mermaid code block, the result is a real interactive canvas with zoomable, drill-downable nested submaps.
---

# /map — generate a flowgo map and share it

You are producing a [flowgo](https://flowgo-map.com) map — a mind-map /
whiteboard / system-map that renders as a live, pannable, zoomable canvas
with nested submaps, not a static diagram image.

## 0. Make sure the hosted MCP is connected

This skill calls the `create_map` tool on flowgo's hosted MCP server. If it
isn't available yet, connect it once:

```
claude mcp add --transport http flowgo https://flowgo-map.com/api/mcp
```

(Cursor / Cline: add the same `https://flowgo-map.com/api/mcp` endpoint as a
remote HTTP MCP server via your client's MCP settings, then re-run this
command.)

If a local `flowgo serve` MCP is connected instead (self-hosted), use
whichever `create_map`-equivalent tool it exposes the same way — the
`.flowgo` text you write is identical either way.

## 1. Design the map

Read the tool's `flowgo://about` MCP resource once if you haven't already —
it's the authoritative `.flowgo` file-format reference (directives,
coordinate system, palette/font scales, shape ids). The short version:

- One node per distinct concept/component/step: `node <id> <label> <x> <y>`.
  Space nodes at least 200px horizontally / 80px vertically so they don't
  overlap.
- `edge <id1> <id2>` connects two nodes (undirected). Use this for
  relationships/flow, not `line`.
- `text <id> <label> <x> <y>` for a free-floating annotation or header that
  isn't itself a node.
- **Nested detail is flowgo's actual differentiator over a flat diagram**:
  give a node its own submap with `map /<node_id>` followed by more
  directives, when a concept deserves to be "drilled into" rather than
  cluttering the top level (e.g. a node "Backend" whose submap breaks out
  into its own services). Don't nest everything — only where a viewer would
  actually want to zoom in.
- Use `palette` (2-9) sparingly to group related nodes by color; leave it
  off (default) where color doesn't carry meaning.
- Keep labels short (a few words); put detail in a nested submap or a `text`
  annotation instead of a long label.

Write the complete `.flowgo` text for the requested topic before calling
the tool — don't build it up incrementally through this skill (that's what
the granular `add_box`/`add_edge`/... tools are for, in a different flow).

## 2. Create the map

Call `create_map` with the full `.flowgo` text as `flowgo_text`. It returns
`{ id, url }`.

If it errors with a parse or validation message, fix the `.flowgo` text
per the error (most often: a duplicate id, an edge referencing an id that
doesn't exist yet, or a directive typo) and retry — don't give up after one
attempt.

## 3. Hand back the link

Tell the user the map is ready and give them the `url` from the result.
Briefly describe what you mapped (a sentence or two), and mention if you
used nested submaps for any part of it so they know to click in. Don't
paste the raw `.flowgo` text back at them — the link is the deliverable.
