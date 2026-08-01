package flowgo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// Minimal MCP (Model Context Protocol) HTTP transport.
// Spec reference: https://spec.modelcontextprotocol.io
//
// Each POST to /mcp carries a JSON-RPC 2.0 request and gets a JSON-RPC
// response back as application/json. No streaming, no sessions tracked here —
// agent-session state lives in WorkspaceManager when serveMode is on.
const mcpProtocolVersion = "2025-06-18"

// snapshot body cap: matches the website's /save and /import.flowgo limits.
const snapshotBodyCap = 1 << 20 // 1 MiB

// mcpInstructions is the agent-facing primer the MCP `initialize`
// response carries in its top-level `instructions` field. Most MCP
// clients surface this string to the model verbatim, so it's the
// highest-leverage place to teach an agent what flowgo is and how to
// produce graphs that don't look terrible. Keep it tight — if it grows
// past a screenful, push detail into the `flowgo://about` resource.
const mcpInstructions = `flowgo is a mind-map / flowchart editor backed by a plain-text .flowgo file. Each file is a tree of maps; each map holds positioned boxes (labelled nodes), edges (undirected links between boxes), free-floating text labels, static lines, and freehand strokes.

MAPS AND SUBMAPS
A map is addressed by path. "/" is the root. "/<box_id>" is the inside of a box — a submap. "/<box_id>/<inner_box_id>" is two levels deep. Submaps are created implicitly the first time you write to a new path; you don't need a "create_map" call. To navigate, pass the path to any tool. Boxes carry the same ids across maps because each map's id space is independent.

COORDINATES
x, y are in CSS-pixel data space. Origin is top-left; +x is right, +y is down. Boxes render roughly 120-180px wide and 36-44px tall depending on label length and font, so space them by at least 200px horizontally and 80px vertically to avoid overlap. A reasonable map fits inside a ~1600x1200 canvas; large maps work but the GUI will need pan/zoom. Always pass distinct coordinates — multiple items at (0, 0) will pile up.

STYLING (1-9 SCALES)
- palette: 1=default (white box, black text), 2=inverted (black bg, white text), 3=red, 4=orange, 5=yellow, 6=green, 7=blue, 8=purple, 9=gray. Applies to boxes, edges, texts, lines, strokes.
- font (boxes, texts): 1=default 14px, scales up to 9 ≈ 56px.
- style (lines only): 1=straight, 2=smooth bezier, 3=orthogonal right-angle elbows.
- shape (boxes only): 0=rectangle (default), 1=hexagon. Hexagons render at a fixed 240x208 size in the GUI and snap onto a hex lattice near other hexagons — they never overlap and are not resizable.

EDGE HANDLES
fromHandle/toHandle pin the connection to a specific side or corner of the source/target box: t (top), r (right), b (bottom), l (left), tl, tr, bl, br. Omit both to let the renderer auto-pick the nearest pair. Edges are undirected — add_edge from A to B is the same edge as B to A; update_edge / delete_edge match in either order.

WHEN TO USE WHICH ENTITY
- box: a labelled node in the conceptual graph. Use for things that have meaning and connect.
- edge: a connection between two boxes. Always between boxes — not to text or lines.
- text: a free-floating annotation. Use for callouts, headers, labels that aren't graph nodes.
- line: a static segment with optional control points. Use for arrows, dividers, geometric shapes.
- stroke: freehand polyline. Use for sketchy annotations; agents rarely need this.
- anchor (a flag on one box per map): marks the recenter target the GUI scrolls to on load. Optional.

GRANULAR VS SET_STATE
Prefer add_*/update_*/delete_* for edits. set_state rewrites the entire graph and runs strict validation; it's the right tool for bulk imports or wholesale layout changes, not for tweaking one box's color.

For the full file-format reference (the .flowgo on-disk syntax), read the resource flowgo://about.`

// flowgoAboutResource is the long-form documentation surfaced via
// resources/read for uri=flowgo://about. Mirrors README's File Format
// section so MCP clients have the same ground truth as the repo.
const flowgoAboutResource = `# flowgo file format and concepts

flowgo round-trips a graph between a browser GUI and a plain-text
.flowgo file. The file is the source of truth — hand-editing is
supported.

## On-disk syntax

UTF-8 text, one directive per line, '#' for comments.

    # optional map header; defaults to "/" if omitted
    map /

    box    <id> <label> <x> <y> [sides] [palette] [font] [rotation]
    edge   <id>[:<handle>] <id>[:<handle>] [palette]
    text   <id> <label> <x> <y> [palette] [font]
    line   <id> <x1> <y1> <x2> <y2> [palette] [mid <x>,<y> ...]
    stroke <id> <x>,<y> <x>,<y> ... [palette]
    linestyle <id> <style>
    boxshape <id> <shape>
    anchor <id>

Notes:
- 'id' is alphanumeric and unique within its map. Granular MCP tools
  mint ids for you (b1, b2, ... for boxes; t* for texts; l* for lines;
  s* for strokes).
- 'label' is a bare word or "quoted string" with escapes \", \\, \n.
- '[sides]' and '[rotation]' in the box directive are VESTIGIAL
  positional slots from removed polygon support. The parser
  validate-and-discards them; new files don't need them. The MCP does
  not advertise sides or rotation as parameters.
- 'map <path>' switches the current map. Paths look like /, /b1,
  /b1/c2. Each path is "the inside of" the box at that path.
- 'boxshape <id> <shape>' tags a box with a non-default silhouette:
  1 = hexagon (fixed 240x208, lattice-snapped, not resizable in the
  GUI); 2-9 reserved. Omitted or 0 = rectangle. Emitted after the box
  block so older binaries still parse the geometry.
- 'anchor <id>' is at most once per map — the per-map recenter target.

## Coordinate system

CSS pixels, origin top-left, +x right, +y down. Default boxes render
roughly 120-180px wide and 36-44px tall (label-dependent). Space them
at least 200px horizontally and 80px vertically.

## Color and size scales

palette (1-9): 1 default, 2 inverted, 3 red, 4 orange, 5 yellow,
6 green, 7 blue, 8 purple, 9 gray.

font (1-9, boxes and texts only): 1 default 14px, 9 largest ~56px.

style (1-9, lines only, GUI uses 1-3): 1 straight, 2 smooth bezier,
3 orthogonal elbows.

## Handle codes (edge endpoints)

t r b l tl tr bl br — pin an edge to a side or corner of the box.
Omit to autoroute to the nearest handle.

## MCP usage notes

- get_state returns the whole graph; use it once at session start to
  learn what exists, then prefer granular tools for edits.
- set_state replaces the entire graph and runs strict validation
  (unknown edge endpoints, malformed entities). Use it for bulk
  imports.
- All add_* tools return the assigned id wrapped as MCP text content.
- All update_* / delete_* tools error on missing id. Look up ids via
  get_state first if you don't have one.
- Submaps are created implicitly: writing add_box {path: "/b1"} when
  /b1 doesn't exist yet creates the submap.
`

type mcpReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type mcpResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *mcpRpcErr      `json:"error,omitempty"`
}

type mcpRpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"name":    "flowgo",
			"version": cfg.Version(),
			"about":   "POST JSON-RPC 2.0 to this endpoint per the MCP streamable-HTTP transport.",
		})
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	var req mcpReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeMCPError(w, nil, -32700, "parse error: "+err.Error())
		return
	}

	isNotification := len(req.ID) == 0 || string(req.ID) == "null"

	resp := mcpResp{JSONRPC: "2.0", ID: req.ID}

	switch req.Method {
	case "initialize":
		resp.Result = map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities": map[string]any{
				"tools":     map[string]any{},
				"resources": map[string]any{},
			},
			"serverInfo": map[string]string{
				"name":    "flowgo",
				"version": cfg.Version(),
			},
			"instructions": mcpInstructions,
		}
	case "notifications/initialized", "notifications/cancelled":
		w.WriteHeader(http.StatusAccepted)
		return
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": mcpTools()}
	case "resources/list":
		resp.Result = map[string]any{"resources": mcpResources()}
	case "resources/read":
		var p struct {
			URI string `json:"uri"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			resp.Error = &mcpRpcErr{Code: -32602, Message: "invalid params: " + err.Error()}
		} else {
			contents, err := mcpResourceRead(p.URI)
			if err != nil {
				resp.Error = &mcpRpcErr{Code: -32602, Message: err.Error()}
			} else {
				resp.Result = map[string]any{"contents": contents}
			}
		}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			resp.Error = &mcpRpcErr{Code: -32602, Message: "invalid params: " + err.Error()}
		} else {
			result, err := dispatchTool(p.Name, p.Arguments)
			if err != nil {
				resp.Result = mcpToolError(err.Error())
			} else {
				resp.Result = result
			}
		}
	default:
		resp.Error = &mcpRpcErr{Code: -32601, Message: "method not found: " + req.Method}
	}

	if isNotification {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func writeMCPError(w http.ResponseWriter, id json.RawMessage, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(mcpResp{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &mcpRpcErr{Code: code, Message: msg},
	})
}

func mcpToolText(s string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": s}},
	}
}

func mcpToolJSON(v any) map[string]any {
	b, _ := json.MarshalIndent(v, "", "  ")
	return mcpToolText(string(b))
}

func mcpToolError(msg string) map[string]any {
	return map[string]any{
		"isError": true,
		"content": []map[string]any{{"type": "text", "text": msg}},
	}
}

// ---------------------------------------------------------------------------
// File-backed graph helpers (local mode).
// ---------------------------------------------------------------------------

func updateFile(f func(g *Graph) error) (Graph, error) {
	cfg.LocalFileMu.Lock()
	defer cfg.LocalFileMu.Unlock()
	data, err := os.ReadFile(cfg.LocalFile)
	if err != nil {
		return Graph{}, err
	}
	g, err := parse(string(data))
	if err != nil {
		return Graph{}, err
	}
	if err := f(&g); err != nil {
		return Graph{}, err
	}
	g.Version = cfg.Version()
	if err := os.WriteFile(cfg.LocalFile, []byte(serialize(g)), 0644); err != nil {
		return Graph{}, err
	}
	return g, nil
}

func readFile() (Graph, error) {
	cfg.LocalFileMu.Lock()
	defer cfg.LocalFileMu.Unlock()
	data, err := os.ReadFile(cfg.LocalFile)
	if err != nil {
		return Graph{}, err
	}
	return parse(string(data))
}

func ensureMapAt(g *Graph, path string) *NamedMap {
	for i, m := range g.Maps {
		if m.Path == path {
			return &g.Maps[i]
		}
	}
	g.Maps = append(g.Maps, NamedMap{Path: path})
	return &g.Maps[len(g.Maps)-1]
}

func nextID(m *NamedMap, prefix string) string {
	used := map[string]bool{}
	for _, b := range m.Boxes {
		used[b.ID] = true
	}
	for _, t := range m.Texts {
		used[t.ID] = true
	}
	for _, l := range m.Lines {
		used[l.ID] = true
	}
	for _, s := range m.Strokes {
		used[s.ID] = true
	}
	for n := 1; ; n++ {
		id := fmt.Sprintf("%s%d", prefix, n)
		if !used[id] {
			return id
		}
	}
}

// ---------------------------------------------------------------------------
// Tool actions — pure functions over a *Graph.
// Local mode wraps them with updateFile / readFile.
// Serve mode wraps them with the per-workspace mutex.
// ---------------------------------------------------------------------------

type toolAction func(g *Graph, args map[string]any) (any, error)

var toolActions = map[string]toolAction{
	"get_state":     actGetState,
	"set_state":     actSetState,
	"add_box":       actAddBox,
	"update_box":    actUpdateBox,
	"delete_box":    actDeleteBox,
	"add_edge":      actAddEdge,
	"update_edge":   actUpdateEdge,
	"delete_edge":   actDeleteEdge,
	"add_text":      actAddText,
	"update_text":   actUpdateText,
	"delete_text":   actDeleteText,
	"add_line":      actAddLine,
	"update_line":   actUpdateLine,
	"delete_line":   actDeleteLine,
	"add_stroke":    actAddStroke,
	"update_stroke": actUpdateStroke,
	"delete_stroke": actDeleteStroke,
}

func isReadOnlyTool(name string) bool { return name == "get_state" }

func actGetState(g *Graph, args map[string]any) (any, error) {
	return mcpToolJSON(*g), nil
}

func actSetState(g *Graph, args map[string]any) (any, error) {
	raw, ok := args["graph"]
	if !ok {
		return nil, fmt.Errorf("missing 'graph'")
	}
	b, _ := json.Marshal(raw)
	var newG Graph
	if err := json.Unmarshal(b, &newG); err != nil {
		return nil, fmt.Errorf("invalid graph: %v", err)
	}
	// Backfill missing ids before validation. Without this, an MCP
	// client that sends `{"texts":[{"label":"x","x":0,"y":0}]}` would
	// poison the on-disk file: Serialize emits an empty-id text line
	// that parse() can't read, and every subsequent updateFile call
	// fails at the parse step before reaching its mutation.
	for i := range newG.Maps {
		m := &newG.Maps[i]
		for j := range m.Texts {
			if m.Texts[j].ID == "" {
				m.Texts[j].ID = nextID(m, "t")
			}
		}
		for j := range m.Lines {
			if m.Lines[j].ID == "" {
				m.Lines[j].ID = nextID(m, "l")
			}
		}
		for j := range m.Strokes {
			if m.Strokes[j].ID == "" {
				m.Strokes[j].ID = nextID(m, "s")
			}
		}
	}
	if errs := validateGraph(newG); len(errs) > 0 {
		msgs := make([]string, len(errs))
		for i, e := range errs {
			msgs[i] = e.Error()
		}
		return nil, fmt.Errorf("graph rejected: %s", strings.Join(msgs, "; "))
	}
	*g = newG
	return mcpToolText("ok"), nil
}

func actAddBox(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	label := graph.NormalizeLabel(stringArg(args, "label", ""))
	if label == "" {
		return nil, fmt.Errorf("label is required")
	}
	x := numArg(args, "x", 0)
	y := numArg(args, "y", 0)
	m := ensureMapAt(g, path)
	id := nextID(m, "b")
	box := Box{ID: id, Label: label, X: x, Y: y}
	if v, ok := args["palette"]; ok {
		p, err := styleProp(v, "palette")
		if err != nil {
			return nil, err
		}
		box.Palette = p
	}
	if v, ok := args["font"]; ok {
		f, err := styleProp(v, "font")
		if err != nil {
			return nil, err
		}
		box.Font = f
	}
	if v, ok := args["anchor"]; ok {
		if b, ok := v.(bool); ok && b {
			box.Anchor = true
			clearOtherAnchors(m, id)
		}
	}
	w, err := boxSizeArgs(args)
	if err != nil {
		return nil, err
	}
	if w != nil {
		box.W, box.H = w[0], w[1]
	}
	if v, ok := args["shape"]; ok {
		s, err := shapeProp(v)
		if err != nil {
			return nil, err
		}
		box.Shape = s
		// Hexagons keep the fixed lattice size. Rejecting (rather than
		// silently dropping) a size given alongside shape=1 tells the
		// MCP client its intent can't be honoured.
		if s == 1 && (box.W != 0 || box.H != 0) {
			return nil, fmt.Errorf("hexagons have a fixed size and are not resizable — omit w/h")
		}
	}
	m.Boxes = append(m.Boxes, box)
	return mcpToolText(id), nil
}

// Explicit-size floor, mirroring MIN_BOX_W / MIN_BOX_H in the editor's
// movers.ts (and the CSS min-width on .box). Clamping here keeps
// MCP-written sizes inside the same envelope the GUI can produce.
const (
	minBoxW = 80
	minBoxH = 36
)

// boxSizeArgs validates the w/h pair on add_box / update_box.
// Returns nil when neither is present, [2]float64{0,0} when both are
// zero (the "restore auto-size" sentinel, only meaningful on update),
// or the clamped size when both are positive. One-sided input is an
// error — a half-specified size has no sensible meaning.
func boxSizeArgs(args map[string]any) (*[2]float64, error) {
	_, hasW := args["w"]
	_, hasH := args["h"]
	if !hasW && !hasH {
		return nil, nil
	}
	if hasW != hasH {
		return nil, fmt.Errorf("w and h must be given together")
	}
	w := numArg(args, "w", 0)
	h := numArg(args, "h", 0)
	if w == 0 && h == 0 {
		return &[2]float64{0, 0}, nil
	}
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("w and h must both be positive (or both 0 to restore auto-size)")
	}
	if w < minBoxW {
		w = minBoxW
	}
	if h < minBoxH {
		h = minBoxH
	}
	return &[2]float64{w, h}, nil
}

func actUpdateBox(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	_, hasLabel := args["label"]
	_, hasX := args["x"]
	_, hasY := args["y"]
	_, hasPalette := args["palette"]
	_, hasFont := args["font"]
	anchorArg, hasAnchor := args["anchor"]
	shapeArg, hasShape := args["shape"]
	m := ensureMapAt(g, path)
	for i := range m.Boxes {
		if m.Boxes[i].ID != id {
			continue
		}
		if hasLabel {
			m.Boxes[i].Label = graph.NormalizeLabel(
				stringArg(args, "label", m.Boxes[i].Label),
			)
		}
		if hasX {
			m.Boxes[i].X = numArg(args, "x", m.Boxes[i].X)
		}
		if hasY {
			m.Boxes[i].Y = numArg(args, "y", m.Boxes[i].Y)
		}
		if hasPalette {
			p, err := styleProp(args["palette"], "palette")
			if err != nil {
				return nil, err
			}
			m.Boxes[i].Palette = p
		}
		if hasFont {
			f, err := styleProp(args["font"], "font")
			if err != nil {
				return nil, err
			}
			m.Boxes[i].Font = f
		}
		if hasAnchor {
			b, ok := anchorArg.(bool)
			if !ok {
				return nil, fmt.Errorf("anchor must be a boolean")
			}
			if b {
				m.Boxes[i].Anchor = true
				clearOtherAnchors(m, id)
			} else {
				m.Boxes[i].Anchor = false
			}
		}
		size, err := boxSizeArgs(args)
		if err != nil {
			return nil, err
		}
		newShape := m.Boxes[i].Shape
		if hasShape {
			s, err := shapeProp(shapeArg)
			if err != nil {
				return nil, err
			}
			newShape = s
		}
		// Hexagons have a fixed lattice size — any explicit w/h aimed
		// at one (whether it already is a hex or becomes one in this
		// call) is rejected so the client learns its intent can't be
		// honoured. Becoming a hexagon clears a previously pinned size.
		if size != nil && newShape == 1 {
			return nil, fmt.Errorf("hexagons have a fixed size and are not resizable — omit w/h")
		}
		if size != nil {
			// {0,0} restores auto-size; anything else pins the size.
			m.Boxes[i].W, m.Boxes[i].H = size[0], size[1]
		}
		if hasShape {
			m.Boxes[i].Shape = newShape
			if newShape == 1 {
				m.Boxes[i].W, m.Boxes[i].H = 0, 0
			}
		}
		return mcpToolText("ok"), nil
	}
	return nil, fmt.Errorf("box %s not found in map %s", id, path)
}

func actDeleteBox(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	m := ensureMapAt(g, path)
	before := len(m.Boxes)
	m.Boxes = filterBoxes(m.Boxes, func(b Box) bool { return b.ID != id })
	if len(m.Boxes) == before {
		return nil, fmt.Errorf("box %s not found in map %s", id, path)
	}
	m.Edges = filterEdges(m.Edges, func(e Edge) bool { return e.From != id && e.To != id })
	subPrefix := joinPath(path, id)
	g.Maps = filterMaps(g.Maps, func(nm NamedMap) bool {
		return nm.Path != subPrefix && !hasPrefix(nm.Path, subPrefix+"/")
	})
	return mcpToolText("ok"), nil
}

func actAddEdge(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	from := stringArg(args, "from", "")
	to := stringArg(args, "to", "")
	if from == "" || to == "" {
		return nil, fmt.Errorf("'from' and 'to' are required")
	}
	fromHandle := stringArg(args, "fromHandle", "")
	toHandle := stringArg(args, "toHandle", "")
	edge := Edge{From: from, FromHandle: fromHandle, To: to, ToHandle: toHandle}
	if v, ok := args["palette"]; ok {
		p, err := styleProp(v, "palette")
		if err != nil {
			return nil, err
		}
		edge.Palette = p
	}
	m := ensureMapAt(g, path)
	m.Edges = filterEdges(m.Edges, func(e Edge) bool {
		return !((e.From == from && e.To == to) || (e.From == to && e.To == from))
	})
	m.Edges = append(m.Edges, edge)
	return mcpToolText("ok"), nil
}

// actUpdateEdge mutates the (undirected) edge between two box ids.
// Mirrors actUpdateBox's diff-on-presence pattern so a caller can flip
// just the palette or just re-aim a handle without disturbing the rest.
func actUpdateEdge(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	from := stringArg(args, "from", "")
	to := stringArg(args, "to", "")
	if from == "" || to == "" {
		return nil, fmt.Errorf("'from' and 'to' are required")
	}
	_, hasFromHandle := args["fromHandle"]
	_, hasToHandle := args["toHandle"]
	_, hasPalette := args["palette"]
	m := ensureMapAt(g, path)
	for i := range m.Edges {
		e := &m.Edges[i]
		match := (e.From == from && e.To == to)
		reverse := (e.From == to && e.To == from)
		if !match && !reverse {
			continue
		}
		if hasFromHandle {
			h := stringArg(args, "fromHandle", "")
			if reverse {
				e.ToHandle = h
			} else {
				e.FromHandle = h
			}
		}
		if hasToHandle {
			h := stringArg(args, "toHandle", "")
			if reverse {
				e.FromHandle = h
			} else {
				e.ToHandle = h
			}
		}
		if hasPalette {
			p, err := styleProp(args["palette"], "palette")
			if err != nil {
				return nil, err
			}
			e.Palette = p
		}
		return mcpToolText("ok"), nil
	}
	return nil, fmt.Errorf("no edge between %s and %s in map %s", from, to, path)
}

func actDeleteEdge(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	from := stringArg(args, "from", "")
	to := stringArg(args, "to", "")
	if from == "" || to == "" {
		return nil, fmt.Errorf("'from' and 'to' are required")
	}
	m := ensureMapAt(g, path)
	before := len(m.Edges)
	m.Edges = filterEdges(m.Edges, func(e Edge) bool {
		return !((e.From == from && e.To == to) || (e.From == to && e.To == from))
	})
	if len(m.Edges) == before {
		return nil, fmt.Errorf("no edge between %s and %s in map %s", from, to, path)
	}
	return mcpToolText("ok"), nil
}

func actAddText(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	label := graph.NormalizeLabel(stringArg(args, "label", ""))
	if label == "" {
		return nil, fmt.Errorf("label is required")
	}
	x := numArg(args, "x", 0)
	y := numArg(args, "y", 0)
	m := ensureMapAt(g, path)
	id := nextID(m, "t")
	t := Text{ID: id, Label: label, X: x, Y: y}
	if v, ok := args["palette"]; ok {
		p, err := styleProp(v, "palette")
		if err != nil {
			return nil, err
		}
		t.Palette = p
	}
	if v, ok := args["font"]; ok {
		f, err := styleProp(v, "font")
		if err != nil {
			return nil, err
		}
		t.Font = f
	}
	m.Texts = append(m.Texts, t)
	return mcpToolText(id), nil
}

func actUpdateText(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	_, hasLabel := args["label"]
	_, hasX := args["x"]
	_, hasY := args["y"]
	_, hasPalette := args["palette"]
	_, hasFont := args["font"]
	m := ensureMapAt(g, path)
	for i := range m.Texts {
		if m.Texts[i].ID != id {
			continue
		}
		if hasLabel {
			next := graph.NormalizeLabel(stringArg(args, "label", m.Texts[i].Label))
			if next == "" {
				return nil, fmt.Errorf("label is required")
			}
			m.Texts[i].Label = next
		}
		if hasX {
			m.Texts[i].X = numArg(args, "x", m.Texts[i].X)
		}
		if hasY {
			m.Texts[i].Y = numArg(args, "y", m.Texts[i].Y)
		}
		if hasPalette {
			p, err := styleProp(args["palette"], "palette")
			if err != nil {
				return nil, err
			}
			m.Texts[i].Palette = p
		}
		if hasFont {
			f, err := styleProp(args["font"], "font")
			if err != nil {
				return nil, err
			}
			m.Texts[i].Font = f
		}
		return mcpToolText("ok"), nil
	}
	return nil, fmt.Errorf("text %s not found in map %s", id, path)
}

func actDeleteText(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	m := ensureMapAt(g, path)
	before := len(m.Texts)
	out := m.Texts[:0]
	for _, t := range m.Texts {
		if t.ID != id {
			out = append(out, t)
		}
	}
	m.Texts = out
	if len(m.Texts) == before {
		return nil, fmt.Errorf("text %s not found in map %s", id, path)
	}
	return mcpToolText("ok"), nil
}

func actAddLine(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	x1 := numArg(args, "x1", 0)
	y1 := numArg(args, "y1", 0)
	x2 := numArg(args, "x2", 0)
	y2 := numArg(args, "y2", 0)
	m := ensureMapAt(g, path)
	id := nextID(m, "l")
	ln := Line{ID: id, X1: x1, Y1: y1, X2: x2, Y2: y2}
	if v, ok := args["palette"]; ok {
		p, err := styleProp(v, "palette")
		if err != nil {
			return nil, err
		}
		ln.Palette = p
	}
	if v, ok := args["style"]; ok {
		s, err := styleProp(v, "style")
		if err != nil {
			return nil, err
		}
		ln.Style = s
	}
	if v, ok := args["mids"]; ok {
		mids, err := pointPairs(v, "mids")
		if err != nil {
			return nil, err
		}
		ln.Mids = mids
	}
	m.Lines = append(m.Lines, ln)
	return mcpToolText(id), nil
}

func actUpdateLine(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	_, hasX1 := args["x1"]
	_, hasY1 := args["y1"]
	_, hasX2 := args["x2"]
	_, hasY2 := args["y2"]
	_, hasPalette := args["palette"]
	_, hasStyle := args["style"]
	_, hasMids := args["mids"]
	m := ensureMapAt(g, path)
	for i := range m.Lines {
		if m.Lines[i].ID != id {
			continue
		}
		if hasX1 {
			m.Lines[i].X1 = numArg(args, "x1", m.Lines[i].X1)
		}
		if hasY1 {
			m.Lines[i].Y1 = numArg(args, "y1", m.Lines[i].Y1)
		}
		if hasX2 {
			m.Lines[i].X2 = numArg(args, "x2", m.Lines[i].X2)
		}
		if hasY2 {
			m.Lines[i].Y2 = numArg(args, "y2", m.Lines[i].Y2)
		}
		if hasPalette {
			p, err := styleProp(args["palette"], "palette")
			if err != nil {
				return nil, err
			}
			m.Lines[i].Palette = p
		}
		if hasStyle {
			s, err := styleProp(args["style"], "style")
			if err != nil {
				return nil, err
			}
			m.Lines[i].Style = s
		}
		if hasMids {
			// Allow explicit null/empty to clear control points — the
			// GUI's double-click-green-dot removal needs an equivalent.
			if args["mids"] == nil {
				m.Lines[i].Mids = nil
			} else {
				mids, err := pointPairs(args["mids"], "mids")
				if err != nil {
					return nil, err
				}
				m.Lines[i].Mids = mids
			}
		}
		return mcpToolText("ok"), nil
	}
	return nil, fmt.Errorf("line %s not found in map %s", id, path)
}

func actDeleteLine(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	m := ensureMapAt(g, path)
	before := len(m.Lines)
	out := m.Lines[:0]
	for _, ln := range m.Lines {
		if ln.ID != id {
			out = append(out, ln)
		}
	}
	m.Lines = out
	if len(m.Lines) == before {
		return nil, fmt.Errorf("line %s not found in map %s", id, path)
	}
	return mcpToolText("ok"), nil
}

func actAddStroke(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	raw, ok := args["points"]
	if !ok {
		return nil, fmt.Errorf("points is required (array of [x, y] pairs)")
	}
	pts, err := pointPairs(raw, "points")
	if err != nil {
		return nil, err
	}
	if len(pts) < 2 {
		return nil, fmt.Errorf("a stroke needs at least two points")
	}
	s := Stroke{Points: pts}
	if v, ok := args["palette"]; ok {
		p, err := styleProp(v, "palette")
		if err != nil {
			return nil, err
		}
		s.Palette = p
	}
	m := ensureMapAt(g, path)
	s.ID = nextID(m, "s")
	m.Strokes = append(m.Strokes, s)
	return mcpToolText(s.ID), nil
}

func actUpdateStroke(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	_, hasPalette := args["palette"]
	_, hasPoints := args["points"]
	m := ensureMapAt(g, path)
	for i := range m.Strokes {
		if m.Strokes[i].ID != id {
			continue
		}
		if hasPalette {
			p, err := styleProp(args["palette"], "palette")
			if err != nil {
				return nil, err
			}
			m.Strokes[i].Palette = p
		}
		if hasPoints {
			pts, err := pointPairs(args["points"], "points")
			if err != nil {
				return nil, err
			}
			if len(pts) < 2 {
				return nil, fmt.Errorf("a stroke needs at least two points")
			}
			m.Strokes[i].Points = pts
		}
		return mcpToolText("ok"), nil
	}
	return nil, fmt.Errorf("stroke %s not found in map %s", id, path)
}

func actDeleteStroke(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	id := stringArg(args, "id", "")
	if id == "" {
		return nil, fmt.Errorf("id is required")
	}
	m := ensureMapAt(g, path)
	before := len(m.Strokes)
	out := m.Strokes[:0]
	for _, s := range m.Strokes {
		if s.ID != id {
			out = append(out, s)
		}
	}
	m.Strokes = out
	if len(m.Strokes) == before {
		return nil, fmt.Errorf("stroke %s not found in map %s", id, path)
	}
	return mcpToolText("ok"), nil
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

func dispatchTool(name string, raw json.RawMessage) (any, error) {
	var args map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, fmt.Errorf("bad arguments: %v", err)
		}
	}

	if cfg.ServeMode {
		switch name {
		case "start_workspace":
			return mcpToolText(cfg.Workspaces.Start()), nil
		case "share":
			return shareWorkspace(args)
		}
	}

	fn, ok := toolActions[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool: %s", name)
	}

	if cfg.ServeMode {
		wsID := stringArg(args, "workspace_id", "")
		if wsID == "" {
			return nil, fmt.Errorf("workspace_id is required (call start_workspace first)")
		}
		var result any
		var inner error
		err := cfg.Workspaces.With(wsID, func(ws *Workspace) error {
			r, e := fn(&ws.Graph, args)
			result = r
			inner = e
			return nil
		})
		if err != nil {
			return nil, err
		}
		if inner != nil {
			return nil, inner
		}
		return result, nil
	}

	// Local mode — operate on the file.
	if isReadOnlyTool(name) {
		g, err := readFile()
		if err != nil {
			return nil, err
		}
		return fn(&g, args)
	}
	var result any
	var inner error
	_, err := updateFile(func(g *Graph) error {
		r, e := fn(g, args)
		result = r
		inner = e
		if e != nil {
			return e
		}
		return nil
	})
	if err != nil && inner == nil {
		return nil, err
	}
	if inner != nil {
		return nil, inner
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// Tool list (mode-aware)
// ---------------------------------------------------------------------------

func mcpTools() []mcpToolDef {
	var tools []mcpToolDef
	if cfg.ServeMode {
		tools = append(tools,
			mcpToolDef{
				Name:        "start_workspace",
				Description: "Create a new in-memory workspace for this session and return its workspace_id. All subsequent tool calls in this session must include workspace_id.",
				InputSchema: schemaObject(map[string]any{}, nil),
			},
			mcpToolDef{
				Name:        "share",
				Description: "Persist the current workspace as an immutable snapshot via the configured webhook. Returns { id, url } the agent should hand to a human.",
				InputSchema: schemaObject(map[string]any{
					"workspace_id": schemaString("Workspace id from start_workspace."),
				}, []string{"workspace_id"}),
			},
		)
	}

	wsArg := func(props map[string]any, required []string) (map[string]any, []string) {
		if !cfg.ServeMode {
			return props, required
		}
		np := map[string]any{"workspace_id": schemaString("Workspace id from start_workspace.")}
		for k, v := range props {
			np[k] = v
		}
		nr := append([]string{"workspace_id"}, required...)
		return np, nr
	}

	addTool := func(name, desc string, props map[string]any, required []string) {
		props, required = wsArg(props, required)
		tools = append(tools, mcpToolDef{Name: name, Description: desc, InputSchema: schemaObject(props, required)})
	}

	addTool("get_state",
		"Read and return the entire flowgo graph (every map with its boxes, edges, texts, lines, and strokes). Call once at session start to learn what exists; for edits prefer granular add_/update_/delete_ tools over a get/mutate/set round-trip.",
		map[string]any{}, nil)

	addTool("set_state",
		"Replace the entire graph with the supplied object. Heavy and validation-strict — use for bulk imports or wholesale layout swaps, not for tweaking single items. Shape: { maps: [{ path, boxes, edges, texts, lines, strokes }] }. Entity fields match the granular add_* / update_* tools. See flowgo://about for the full field reference.",
		map[string]any{
			"graph": map[string]any{"type": "object", "description": "Full graph to write."},
		}, []string{"graph"})

	paletteSchema := schemaNumber("Optional color: 1=default white, 2=inverted black, 3=red, 4=orange, 5=yellow, 6=green, 7=blue, 8=purple, 9=gray.")
	fontSchema := schemaNumber("Optional font-size step: 1=default 14px, 2-9 progressively larger up to 56px.")
	lineStyleSchema := schemaNumber("Optional render style: 1=straight (default), 2=smooth bezier, 3=orthogonal elbows.")
	pointArraySchema := func(desc string) map[string]any {
		return map[string]any{
			"type":        "array",
			"description": desc,
			"items": map[string]any{
				"type":     "array",
				"items":    map[string]any{"type": "number"},
				"minItems": 2,
				"maxItems": 2,
			},
		}
	}

	addTool("add_box",
		"Add a box (labelled node) to the map at the given path. Returns the assigned id. Space boxes by at least 200px x / 80px y to avoid overlap.",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"label":   schemaString("Box label. Supports embedded \\n for hard line breaks; runs through the same normalisation as the GUI (trim, collapse internal whitespace, max 200 chars)."),
			"x":       schemaNumber("X in CSS-pixel data space. Origin top-left, +x right."),
			"y":       schemaNumber("Y in CSS-pixel data space. Origin top-left, +y down."),
			"palette": paletteSchema,
			"font":    fontSchema,
			"anchor":  map[string]any{"type": "boolean", "description": "Set true to make this box the map's recenter anchor (clears any prior anchor on the same map). At most one anchor per map."},
			"w":       schemaNumber("Optional explicit width in data px (min 80). Both w and h must be given to pin the size; omit both for auto-size (box hugs its label). Ignored for hexagons."),
			"h":       schemaNumber("Optional explicit height in data px (min 36). Both w and h must be given to pin the size; omit both for auto-size. Ignored for hexagons."),
			"shape":   schemaNumber("Optional shape: 0=rectangle (default), 1=hexagon. Hexagons render at a fixed 240x208 size, snap onto a hex lattice near other hexagons, never overlap, and are not resizable."),
		}, []string{"label", "x", "y"})

	addTool("update_box",
		"Update a box's label, position, color, font size, shape, anchor flag, or explicit size. Pass 1 for palette or font to reset to default. Pass w=0 and h=0 to restore auto-sizing.",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":      schemaString("Box id."),
			"label":   schemaString("New label (optional)."),
			"x":       schemaNumber("New x (optional)."),
			"y":       schemaNumber("New y (optional)."),
			"palette": schemaNumber("Optional palette index 1..9."),
			"font":    schemaNumber("Optional font-size step 1..9."),
			"anchor":  map[string]any{"type": "boolean", "description": "true sets this box as the map's anchor (clears any prior); false clears the anchor flag on this box."},
			"w":       schemaNumber("New explicit width in data px, min 80 (optional; set both w and h). 0 together with h=0 restores auto-size. Ignored for hexagons."),
			"h":       schemaNumber("New explicit height in data px, min 36 (optional; set both w and h). 0 together with w=0 restores auto-size. Ignored for hexagons."),
			"shape":   schemaNumber("Optional shape: 0=rectangle (default), 1=hexagon (fixed 240x208, lattice-snapped, not resizable). Combining shape=1 with w/h is an error; becoming a hexagon clears any previously pinned size."),
		}, []string{"id"})

	addTool("delete_box",
		"Delete a box (and all incident edges plus its submap subtree).",
		map[string]any{
			"path": schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":   schemaString("Box id."),
		}, []string{"id"})

	handleSchema := schemaString("Edge endpoint handle: t r b l tl tr bl br (sides + corners). Omit to autoroute to the nearest handle.")

	addTool("add_edge",
		"Add an undirected edge between two boxes in the same map. Replaces any prior edge between the same pair. Edges only connect boxes — not text, lines, or strokes.",
		map[string]any{
			"path":       schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"from":       schemaString("Source box id."),
			"to":         schemaString("Target box id."),
			"fromHandle": handleSchema,
			"toHandle":   handleSchema,
			"palette":    paletteSchema,
		}, []string{"from", "to"})

	addTool("update_edge",
		"Update the edge between two boxes: re-aim a handle or set the palette. Identify the edge by 'from'/'to' in either order (edges are undirected); handle args are interpreted relative to the args' direction.",
		map[string]any{
			"path":       schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"from":       schemaString("One endpoint box id (matches in either direction)."),
			"to":         schemaString("Other endpoint box id (matches in either direction)."),
			"fromHandle": handleSchema,
			"toHandle":   handleSchema,
			"palette":    schemaNumber("Optional palette index 1..9 (1 resets to default)."),
		}, []string{"from", "to"})

	addTool("delete_edge",
		"Delete the edge between two box ids in the same map.",
		map[string]any{
			"path": schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"from": schemaString("Source box id."),
			"to":   schemaString("Target box id."),
		}, []string{"from", "to"})

	addTool("add_text",
		"Add a free-floating text annotation (header, callout, label). Use a box instead if the item should connect to other items via edges.",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"label":   schemaString("Text content. Embedded \\n produces hard line breaks; same normalisation as box labels."),
			"x":       schemaNumber("X in CSS-pixel data space. Origin top-left, +x right."),
			"y":       schemaNumber("Y in CSS-pixel data space. Origin top-left, +y down."),
			"palette": paletteSchema,
			"font":    fontSchema,
		}, []string{"label", "x", "y"})

	addTool("update_text",
		"Update a text label's content, position, color, or font size. Pass 1 for palette or font to reset to default.",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":      schemaString("Text id."),
			"label":   schemaString("New label (optional)."),
			"x":       schemaNumber("New x (optional)."),
			"y":       schemaNumber("New y (optional)."),
			"palette": schemaNumber("Optional palette index 1..9."),
			"font":    schemaNumber("Optional font-size step 1..9."),
		}, []string{"id"})

	addTool("delete_text",
		"Delete a free-floating text label.",
		map[string]any{
			"path": schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":   schemaString("Text id."),
		}, []string{"id"})

	addTool("add_line",
		"Add a static line segment (arrow, divider, geometric shape). Use 'mids' for a polyline through control points. Use edges (not lines) to connect boxes.",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"x1":      schemaNumber("Start x in CSS-pixel data space."),
			"y1":      schemaNumber("Start y in CSS-pixel data space."),
			"x2":      schemaNumber("End x in CSS-pixel data space."),
			"y2":      schemaNumber("End y in CSS-pixel data space."),
			"palette": paletteSchema,
			"style":   lineStyleSchema,
			"mids":    pointArraySchema("Optional intermediate control points as [x, y] pairs, in order between start and end."),
		}, []string{"x1", "y1", "x2", "y2"})

	addTool("update_line",
		"Update a line's endpoints, color, render style, or control points. Pass 1 for palette/style to reset to default. Pass null for 'mids' to clear all control points.",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":      schemaString("Line id."),
			"x1":      schemaNumber("New start x (optional)."),
			"y1":      schemaNumber("New start y (optional)."),
			"x2":      schemaNumber("New end x (optional)."),
			"y2":      schemaNumber("New end y (optional)."),
			"palette": schemaNumber("Optional palette index 1..9."),
			"style":   schemaNumber("Optional render style 1..9 (1 straight, 2 bezier, 3 orthogonal)."),
			"mids":    pointArraySchema("Replacement control-point list as [x, y] pairs. Pass null or [] to clear."),
		}, []string{"id"})

	addTool("delete_line",
		"Delete a static line segment.",
		map[string]any{
			"path": schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":   schemaString("Line id."),
		}, []string{"id"})

	strokePointSchema := pointArraySchema("Array of [x, y] coordinate pairs in canvas space, in stroke order.")
	strokePointSchema["minItems"] = 2

	addTool("add_stroke",
		"Add a freehand brush stroke (sketchy annotation). Provide at least two [x, y] points. Prefer 'line' for structured geometry; reach for stroke only when you want a hand-drawn look.",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"points":  strokePointSchema,
			"palette": paletteSchema,
		}, []string{"points"})

	addTool("update_stroke",
		"Update a stroke's color or replace its full point list (useful for translating the whole stroke).",
		map[string]any{
			"path":    schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":      schemaString("Stroke id."),
			"points":  strokePointSchema,
			"palette": schemaNumber("Optional palette index 1..9."),
		}, []string{"id"})

	addTool("delete_stroke",
		"Delete a freehand brush stroke.",
		map[string]any{
			"path": schemaString("Map path: '/' for root, '/<box_id>' for a box's submap, '/<box_id>/<inner_id>' deeper. Defaults to '/'. Submaps are created implicitly on first write."),
			"id":   schemaString("Stroke id."),
		}, []string{"id"})

	return tools
}

// mcpResources lists the static documentation resources flowgo
// publishes for MCP clients. Resources are how an agent discovers
// non-tool context — file-format reference, conventions, examples.
// Keep the list small; add new entries only when a topic genuinely
// doesn't fit inside a tool description or the initialize
// instructions string.
type mcpResourceDef struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Description string `json:"description"`
	MIMEType    string `json:"mimeType"`
}

func mcpResources() []mcpResourceDef {
	return []mcpResourceDef{
		{
			URI:         "flowgo://about",
			Name:        "flowgo file format and concepts",
			Description: "Full reference for the .flowgo on-disk syntax, coordinate system, palette/font/style scales, edge handle codes, and MCP usage notes. Read once at session start if you need detail beyond the initialize instructions.",
			MIMEType:    "text/markdown",
		},
	}
}

// mcpResourceRead returns the contents array MCP expects from a
// resources/read response. The wire shape is an array of {uri, text,
// mimeType} entries; flowgo serves a single text document per uri.
func mcpResourceRead(uri string) ([]map[string]any, error) {
	switch uri {
	case "flowgo://about":
		return []map[string]any{{
			"uri":      uri,
			"mimeType": "text/markdown",
			"text":     flowgoAboutResource,
		}}, nil
	default:
		return nil, fmt.Errorf("unknown resource uri: %s", uri)
	}
}

func schemaObject(props map[string]any, required []string) map[string]any {
	out := map[string]any{
		"type":       "object",
		"properties": props,
	}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func schemaString(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func schemaNumber(desc string) map[string]any {
	return map[string]any{"type": "number", "description": desc}
}

// ---------------------------------------------------------------------------
// share — POST workspace graph to the configured webhook with bearer + sha256.
// ---------------------------------------------------------------------------

func shareWorkspace(args map[string]any) (any, error) {
	wsID := stringArg(args, "workspace_id", "")
	if wsID == "" {
		return nil, fmt.Errorf("workspace_id is required")
	}
	if cfg.ShareWebhookURL == "" {
		return nil, fmt.Errorf("share is unconfigured: --share-webhook missing")
	}

	var graphCopy Graph
	if err := cfg.Workspaces.With(wsID, func(ws *Workspace) error {
		graphCopy = ws.Graph
		return nil
	}); err != nil {
		return nil, err
	}

	graphJSON, err := json.Marshal(graphCopy)
	if err != nil {
		return nil, fmt.Errorf("marshal graph: %v", err)
	}
	if len(graphJSON) > snapshotBodyCap {
		return nil, fmt.Errorf("graph too large: %d bytes (cap %d)", len(graphJSON), snapshotBodyCap)
	}

	h := sha256.Sum256(graphJSON)
	fingerprint := "sha256:" + hex.EncodeToString(h[:])

	payload, err := json.Marshal(map[string]any{
		"graph":                 graphCopy,
		"workspace_fingerprint": fingerprint,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, cfg.ShareWebhookURL, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.ShareWebhookSecret != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.ShareWebhookSecret)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("webhook call failed: %v", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("webhook returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var out struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return nil, fmt.Errorf("invalid webhook response: %v (body: %s)", err, string(respBody))
	}
	return mcpToolJSON(map[string]string{"id": out.ID, "url": out.URL}), nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func stringArg(args map[string]any, key, def string) string {
	if v, ok := args[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return def
}

func numArg(args map[string]any, key string, def float64) float64 {
	if v, ok := args[key]; ok {
		switch n := v.(type) {
		case float64:
			return n
		case int:
			return float64(n)
		}
	}
	return def
}

// styleProp parses a 1..9 styling argument (palette, font, line style)
// per the file-format convention: 1 is the default and stored as 0 so
// it round-trips as the absent-token. Returns the storage value.
// shapeProp validates the box shape argument: 0 = rectangle
// (default, stored as the zero value), 1 = hexagon. 2-9 are reserved
// in the file format but not accepted over MCP until something
// renders them.
func shapeProp(v any) (int, error) {
	n := intFromAny(v)
	if n != 0 && n != 1 {
		return 0, fmt.Errorf("shape must be 0 (rectangle) or 1 (hexagon)")
	}
	return n, nil
}

func styleProp(v any, name string) (int, error) {
	n := intFromAny(v)
	switch {
	case n >= 2 && n <= 9:
		return n, nil
	case n == 0 || n == 1:
		return 0, nil
	default:
		return 0, fmt.Errorf("%s must be 1..9", name)
	}
}

// pointPairs decodes a JSON array of [x, y] pairs (as delivered by
// json.Unmarshal into map[string]any: []any of []any). Shared between
// add_stroke / update_stroke (points) and add_line / update_line
// (mids) since both wire-shapes are identical.
func pointPairs(v any, name string) ([][]float64, error) {
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array of [x, y] pairs", name)
	}
	pts := make([][]float64, 0, len(arr))
	for i, p := range arr {
		pair, ok := p.([]any)
		if !ok || len(pair) != 2 {
			return nil, fmt.Errorf("%s[%d] must be [x, y]", name, i)
		}
		px := numArg(map[string]any{"x": pair[0]}, "x", 0)
		py := numArg(map[string]any{"y": pair[1]}, "y", 0)
		pts = append(pts, []float64{px, py})
	}
	return pts, nil
}

// clearOtherAnchors enforces the per-map single-anchor invariant when
// promoting a box to anchor: every other box on the same map loses its
// flag. Mirrors the GUI's toggleAnchor (src/editor/keys.ts) and the
// parser's anchor directive handling.
func clearOtherAnchors(m *NamedMap, keep string) {
	for i := range m.Boxes {
		if m.Boxes[i].ID != keep && m.Boxes[i].Anchor {
			m.Boxes[i].Anchor = false
		}
	}
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case string:
		i, err := strconv.Atoi(n)
		if err == nil {
			return i
		}
	}
	return 0
}

func filterBoxes(in []Box, keep func(Box) bool) []Box {
	out := in[:0]
	for _, b := range in {
		if keep(b) {
			out = append(out, b)
		}
	}
	return out
}

func filterEdges(in []Edge, keep func(Edge) bool) []Edge {
	out := in[:0]
	for _, e := range in {
		if keep(e) {
			out = append(out, e)
		}
	}
	return out
}

func filterMaps(in []NamedMap, keep func(NamedMap) bool) []NamedMap {
	var out []NamedMap
	for _, m := range in {
		if keep(m) {
			out = append(out, m)
		}
	}
	return out
}

func joinPath(parent, id string) string {
	if parent == "/" {
		return "/" + id
	}
	return parent + "/" + id
}

func hasPrefix(s, prefix string) bool {
	if len(prefix) > len(s) {
		return false
	}
	return s[:len(prefix)] == prefix
}
