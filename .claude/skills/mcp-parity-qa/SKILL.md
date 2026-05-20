---
name: mcp-parity-qa
description: Audit flowgo's MCP tool surface against the GUI editor's capabilities and report parity gaps. Use when the user asks about MCP coverage, MCP parity, "is feature X also reachable via MCP", "does the MCP expose everything the GUI can do", or any audit of which editor features an agent client (Claude, Cursor, etc.) can drive over MCP. Also use after a new GUI feature lands, to verify the MCP was updated to match.
---

# flowgo MCP ↔ GUI parity QA

You are the parity auditor for flowgo. Your job is to confirm — with evidence
from the actual code — that every user-facing capability of the browser editor
is also reachable over MCP, so an agent driving a `.flowgo` file headlessly is
not crippled relative to a human at the keyboard.

The default verdict is **GAPS PRESENT** until proven otherwise. Treat anything
you cannot find in `mcp.go` as missing, not "probably wired up somewhere."

## What this skill is NOT for

- Reviewing MCP transport / JSON-RPC framing (use the MCP spec for that).
- Auditing the website / `flowgo-map.com` codebase. This skill is scoped to
  the binary in this repo only.
- Style review on `mcp.go`. Only correctness of the capability surface.

## Inputs

Read these — do not guess:

1. **MCP tool surface** — single source of truth:
   - `mcp.go` → the `toolActions` map (dispatch table)
   - `mcp.go` → the `mcpTools()` function (the `addTool(...)` calls that
     publish each tool's schema to clients)
   - `mcp_test.go` → existing coverage tests; new gaps should grow a test here

2. **GUI capability surface** — enumerate from:
   - `src/editor/index.html` → the `#helpModal` block (`<h3>` sections + `<tr>`
     rows). This is the *advertised* user-facing capability set. Every row is
     a feature claim.
   - `src/editor/keys.ts` → the actual keyboard dispatch. Cross-check against
     the help modal — if a keybind exists here but not in help, it still
     counts as a GUI feature.
   - `src/editor/mouse.ts`, `touch.ts`, `gestures.ts` → pointer interactions
     (drag, alt-drag duplicate, marquee select, etc.).
   - `src/editor/brush.ts`, `src/editor/line.ts`, `src/editor/edit.ts`,
     `src/editor/anchors.ts`, `src/editor/navigation.ts`,
     `src/editor/clipboard.ts` → mode-specific capabilities.

3. **File-format ground truth** — `pkg/graph/serialize.go` and `README.md`
   "File format" section. Anything that can be expressed in `.flowgo` syntax
   but cannot be produced by MCP is a gap.

## Procedure

### 1. Build the GUI capability list

Extract a flat list of distinct *capabilities* (not keybinds). Collapse
synonyms — "click + Box button" and "press +" both map to the same capability
("create a box"). Group them:

- **Create**: box, text, line, stroke, edge, submap (navigate into a box),
  anchor
- **Mutate**: label, position, palette (color), font size, shape (sides),
  edge endpoints / handles
- **Delete**: box, text, line, stroke, edge, anchor
- **Bulk / structural**: paste, duplicate (alt-drag), set-state
  (hand-edit the file)
- **Read / navigate**: pan, zoom, switch map, get current state

### 2. Build the MCP tool list

Read `mcpTools()` in `mcp.go`. List every tool name, its parameters, and
whether it covers create / read / update / delete for each entity type.

Be explicit about the matrix:

| Entity | create | read | update | delete |
|--------|--------|------|--------|--------|
| box    | …      | …    | …      | …      |
| edge   | …      | …    | …      | …      |
| text   | …      | …    | …      | …      |
| line   | …      | …    | …      | …      |
| stroke | …      | …    | …      | …      |
| map    | …      | …    | …      | …      |
| anchor | …      | …    | …      | …      |

`get_state` and `set_state` cover everything in bulk — note that, but do NOT
let it excuse the absence of a granular tool. An agent that has to round-trip
the entire graph to flip one box's color is a real UX gap for the model.

### 3. Classify each gap

For every GUI capability not reachable through a granular MCP tool, classify
it as one of:

- **BLOCKER** — the capability is not reachable at all, not even through
  `set_state`. (Example: if a new entity type exists in the parser but
  `set_state` doesn't accept it.)
- **GRANULAR GAP** — reachable only via `set_state` round-trip. Acceptable
  for rare ops, painful for common ones (recolor, move, relabel).
- **GUI-ONLY BY DESIGN** — viewport state (pan/zoom), pointer ergonomics
  (marquee select, alt-drag), help overlay, undo/redo if local-only.
  Document these so future audits don't re-flag them.

When in doubt, prefer **GRANULAR GAP** over **GUI-ONLY BY DESIGN**. An agent
client is your user too.

### 4. Report

Output one Markdown report with these sections, in this order:

```
## Verdict
PASS | GAPS PRESENT | BLOCKERS PRESENT

## Coverage matrix
<the table from step 2, with ✅ / ⚠️ set-state-only / ❌ / — by-design>

## Blockers
<one bullet per BLOCKER, with file:line evidence and suggested fix>

## Granular gaps
<one bullet per GRANULAR GAP, with file:line evidence and the addTool stanza
that would close it>

## GUI-only by design
<short bulleted list, no remediation needed>

## Suggested test additions
<one bullet per new mcp_test.go case that would catch the gap re-opening>
```

Every claim in Blockers / Granular gaps MUST cite a file path and a line
number — either where the GUI capability lives or where the missing MCP tool
should be added. No vague "the editor can do X" without a pointer.

### 5. Remediation stanzas (when proposing fixes)

When suggesting a new MCP tool, hand the implementer a ready-to-paste pair:

1. An entry for the `toolActions` map and the action function signature
   (`func actUpdateText(g *Graph, args map[string]any) (any, error)`).
2. An `addTool("…", "…", map[string]any{…}, []string{…})` block matching the
   style of the existing tools in `mcpTools()`.

Follow the conventions already in `mcp.go`:

- Path defaults to `/` via `stringArg(args, "path", "/")`.
- IDs are minted via `nextID(m, "<prefix>")`, not accepted from the client.
- Palette and font validation uses the 1..9 pattern from `actAddBox`.
- Workspace-mode tools get `workspace_id` auto-injected by `wsArg` — do not
  add it manually.

## Discoverability audit (run alongside the parity audit)

Parity asks "is the surface complete?". Discoverability asks "can a
first-time agent client figure out how to use it from the surface
itself, with no out-of-band docs?". Both matter — a complete surface
nobody can navigate is still broken.

For every audit, also verify:

1. **`initialize` returns a non-empty `instructions` string.** Most
   MCP clients show this to the model verbatim. It is the single
   highest-leverage place to teach concepts the tool descriptions
   can't carry: coordinate system, when to use which entity, what a
   path is. Pin it with `TestInitialize_HasInstructions` —
   keyword-presence checks for "path", "coordinate", "palette",
   "edge", "submap" so the field can't regress to a stub.

2. **`capabilities.resources` is advertised AND `resources/list`
   returns at least `flowgo://about`.** The about-doc is where the
   .flowgo file-format reference, vestigial slot history, handle
   codes, and implicit-submap behaviour live. Tool descriptions can't
   reasonably hold that much detail.

3. **Tool descriptions are internally consistent.** Recurring
   regressions to watch:
   - Handle codes (`t r b l tl tr bl br`) listed on `add_edge` but
     not on `update_edge`. Extract a shared `handleSchema` rather
     than restating in prose.
   - Coordinate args (`x`, `y`, `x1`, `y1`, …) that say "X
     coordinate" with no units, origin, or scale hint. Always say
     "CSS-pixel data space, origin top-left".
   - `path` descriptions that say "Map path. Defaults to '/'." with
     no mention of the `/box_id` submap convention or the
     implicit-on-write behaviour.
   - Tools that pretend `set_state` is interchangeable with granular
     edits. It isn't (heavy + validation-strict).

4. **No prose claim points at a non-existent resource/capability.**
   If a description says "see flowgo://X" then `resources/read` of
   that URI must succeed.

Report discoverability issues in their own section of the verdict:

```
## Discoverability
PASS | WEAK | MISSING

- <one bullet per gap, e.g. "initialize.instructions empty">
- <or per inconsistency, with the addTool stanza that hosts it>
```

If discoverability is WEAK or MISSING, recommend the same triage as
parity: lowest-effort fix first (a non-empty `instructions` string is
~10 minutes of writing and unblocks every future MCP client).

## Failure modes to watch for

- A new entity type added to `pkg/graph/types.ts` (TS) or
  `pkg/graph/types.go` (Go) without a matching `act*` function — `set_state`
  will accept it, but no granular tool exists.
- A new `palette` or `font` step added to the renderer without the schema
  description in `addTool` being updated (model will pass invalid values).
- A new keybind in `src/editor/keys.ts` (e.g. a shape toggle, a layout
  command) without a corresponding MCP tool.
- `update_*` tools that silently ignore unknown fields instead of erroring
  (this lets schema drift hide).
- `add_*` tools missing optional fields that the GUI lets the user set on
  creation (e.g. creating a box with a non-default palette in one step).

## Done definition

You are done when:

- The report is written.
- Every BLOCKER and GRANULAR GAP has a file:line citation on both sides
  (where the GUI exposes it, where the MCP fails to).
- Every proposed fix has a paste-ready `addTool` + action stanza.
- You have offered to add `mcp_test.go` cases that would have caught each
  gap, so the next regression is loud.

If there are zero gaps, say so plainly — "PASS, parity verified at
commit `<sha>`" — and list the matrix as evidence. Do not invent gaps to look
thorough.
