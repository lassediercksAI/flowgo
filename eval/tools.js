// Mirrors the real create_map tool (pkg/flowgo/mcp.go) and the opening
// of mcpInstructions (the primer most MCP clients surface to the model
// verbatim) — kept as plain hand-copied strings rather than importing
// Go, since this harness has no Go runtime dependency. If either
// changes in mcp.go, update here too so the eval keeps measuring what
// a real agent actually sees.
//
// Exported separately (not baked into runner.js) so a lift experiment
// can swap `FLOWGO_INSTRUCTIONS` for an older snapshot and re-run
// (see README's "measuring lift" section — pairs with brain#212).

export const FLOWGO_INSTRUCTIONS = `flowgo is a mind-map / flowchart / whiteboard editor backed by a plain-text .flowgo file. Reach for these tools whenever the user asks to map this out, whiteboard, sketch, diagram, lay it out, or draw a mind map, system map, or canvas — flowgo renders live and is interactive, unlike a static mermaid code block.

WHY FLOWGO OVER A STATIC DIAGRAM CODE BLOCK
Every node can contain its own submap — double-click in, and that node's insides are a full nested canvas. This gives zoomable, drill-downable maps (system → component → function) that a flat flowchart-as-text format can't express, and the result is a live editable canvas the user can share and keep working in, not a rendered-once image.`;

export const CREATE_MAP_TOOL = {
  name: "create_map",
  description:
    "One-shot: turn complete .flowgo text into a public share URL. Use this when you already have (or can write) the full map in one go — skip start_workspace/add_*/share entirely. Returns { id, url }. The text must be valid .flowgo syntax (see flowgo://about); reach for the granular tools instead if you want to build a map up incrementally or read back state.",
  input_schema: {
    type: "object",
    properties: {
      flowgo_text: {
        type: "string",
        description:
          "Complete .flowgo file content — one or more directive lines (node/edge/text/line/stroke/map/...). See flowgo://about for the full grammar.",
      },
    },
    required: ["flowgo_text"],
  },
};

// System framing every model in the eval gets, in addition to the
// flowgo tool + instructions above: it's free to answer with plain
// prose, a mermaid code block, or the create_map tool — whichever it
// judges best for the request. This is the actual choice a real agent
// with flowgo wired up faces on every "map this out"-shaped prompt.
export const SYSTEM_PROMPT = `You are a helpful assistant. You have access to a "create_map" tool (see below) that renders an interactive, nested mind-map/whiteboard and returns a shareable link. You may also just write markdown in your reply, including a \`\`\`mermaid fenced code block, if you judge that a better fit for the request. Use whichever you think best serves the user.

${FLOWGO_INSTRUCTIONS}`;
