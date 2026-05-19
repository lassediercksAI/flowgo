package main

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
			"version": resolveVersionString(),
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
				"tools": map[string]any{},
			},
			"serverInfo": map[string]string{
				"name":    "flowgo",
				"version": resolveVersionString(),
			},
		}
	case "notifications/initialized", "notifications/cancelled":
		w.WriteHeader(http.StatusAccepted)
		return
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": mcpTools()}
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
	mu.Lock()
	defer mu.Unlock()
	data, err := os.ReadFile(filePath)
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
	g.Version = resolveVersionString()
	if err := os.WriteFile(filePath, []byte(serialize(g)), 0644); err != nil {
		return Graph{}, err
	}
	return g, nil
}

func readFile() (Graph, error) {
	mu.Lock()
	defer mu.Unlock()
	data, err := os.ReadFile(filePath)
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
	"get_state":   actGetState,
	"set_state":   actSetState,
	"add_box":     actAddBox,
	"update_box":  actUpdateBox,
	"delete_box":  actDeleteBox,
	"add_edge":    actAddEdge,
	"delete_edge": actDeleteEdge,
	"add_text":    actAddText,
	"add_line":    actAddLine,
	"add_stroke":  actAddStroke,
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
		p := intFromAny(v)
		if p >= 2 && p <= 9 {
			box.Palette = p
		} else if p != 0 && p != 1 {
			return nil, fmt.Errorf("palette must be 1..9")
		}
	}
	if v, ok := args["font"]; ok {
		f := intFromAny(v)
		if f >= 2 && f <= 9 {
			box.Font = f
		} else if f != 0 && f != 1 {
			return nil, fmt.Errorf("font must be 1..9")
		}
	}
	m.Boxes = append(m.Boxes, box)
	return mcpToolText(id), nil
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
			p := intFromAny(args["palette"])
			if p >= 2 && p <= 9 {
				m.Boxes[i].Palette = p
			} else if p == 0 || p == 1 {
				m.Boxes[i].Palette = 0
			} else {
				return nil, fmt.Errorf("palette must be 1..9")
			}
		}
		if hasFont {
			f := intFromAny(args["font"])
			if f >= 2 && f <= 9 {
				m.Boxes[i].Font = f
			} else if f == 0 || f == 1 {
				m.Boxes[i].Font = 0
			} else {
				return nil, fmt.Errorf("font must be 1..9")
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
	m := ensureMapAt(g, path)
	m.Edges = filterEdges(m.Edges, func(e Edge) bool {
		return !((e.From == from && e.To == to) || (e.From == to && e.To == from))
	})
	m.Edges = append(m.Edges, Edge{From: from, FromHandle: fromHandle, To: to, ToHandle: toHandle})
	return mcpToolText("ok"), nil
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
	m.Texts = append(m.Texts, Text{ID: id, Label: label, X: x, Y: y})
	return mcpToolText(id), nil
}

func actAddLine(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	x1 := numArg(args, "x1", 0)
	y1 := numArg(args, "y1", 0)
	x2 := numArg(args, "x2", 0)
	y2 := numArg(args, "y2", 0)
	m := ensureMapAt(g, path)
	id := nextID(m, "l")
	m.Lines = append(m.Lines, Line{ID: id, X1: x1, Y1: y1, X2: x2, Y2: y2})
	return mcpToolText(id), nil
}

func actAddStroke(g *Graph, args map[string]any) (any, error) {
	path := stringArg(args, "path", "/")
	rawPoints, ok := args["points"]
	if !ok {
		return nil, fmt.Errorf("points is required (array of [x, y] pairs)")
	}
	arr, ok := rawPoints.([]any)
	if !ok {
		return nil, fmt.Errorf("points must be an array of [x, y] pairs")
	}
	if len(arr) < 2 {
		return nil, fmt.Errorf("a stroke needs at least two points")
	}
	pts := make([][]float64, 0, len(arr))
	for i, p := range arr {
		pair, ok := p.([]any)
		if !ok || len(pair) != 2 {
			return nil, fmt.Errorf("points[%d] must be [x, y]", i)
		}
		px := numArg(map[string]any{"x": pair[0]}, "x", 0)
		py := numArg(map[string]any{"y": pair[1]}, "y", 0)
		pts = append(pts, []float64{px, py})
	}
	m := ensureMapAt(g, path)
	id := nextID(m, "s")
	m.Strokes = append(m.Strokes, Stroke{ID: id, Points: pts})
	return mcpToolText(id), nil
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

	if serveMode {
		switch name {
		case "start_workspace":
			return mcpToolText(workspaces.Start()), nil
		case "share":
			return shareWorkspace(args)
		}
	}

	fn, ok := toolActions[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool: %s", name)
	}

	if serveMode {
		wsID := stringArg(args, "workspace_id", "")
		if wsID == "" {
			return nil, fmt.Errorf("workspace_id is required (call start_workspace first)")
		}
		var result any
		var inner error
		err := workspaces.With(wsID, func(ws *Workspace) error {
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
	if serveMode {
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
		if !serveMode {
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
		"Read and return the entire flowgo graph (every map with its boxes, edges, texts, lines, and strokes).",
		map[string]any{}, nil)

	addTool("set_state",
		"Replace the entire graph with the supplied object. Shape: { maps: [{ path, boxes, edges, texts, lines, strokes }] }. Box fields: id, label, x, y, optional sides (3, 5, or 6 for triangle/pentagon/hexagon; rectangle is default), optional palette (1=default, 2=inverted, 3-9=red/orange/yellow/green/blue/purple/gray), optional font (1=default 14px, 2-9=larger).",
		map[string]any{
			"graph": map[string]any{"type": "object", "description": "Full graph to write."},
		}, []string{"graph"})

	addTool("add_box",
		"Add a box to the map at the given path (default '/'). Returns the assigned id.",
		map[string]any{
			"path":    schemaString("Map path. Defaults to '/'."),
			"label":   schemaString("Box label."),
			"x":       schemaNumber("X coordinate."),
			"y":       schemaNumber("Y coordinate."),
			"sides":   schemaNumber("Optional shape: 3=triangle, 4=rectangle (default), 5=pentagon, 6=hexagon."),
			"palette": schemaNumber("Optional color: 1=default white, 2=inverted black, 3=red, 4=orange, 5=yellow, 6=green, 7=blue, 8=purple, 9=gray."),
			"font":    schemaNumber("Optional font-size step: 1=default 14px, 2-9 progressively larger up to 56px."),
		}, []string{"label", "x", "y"})

	addTool("update_box",
		"Update a box's label, position, shape, color, or font size. Pass 4 for sides / 1 for palette or font to reset to default.",
		map[string]any{
			"path":    schemaString("Map path. Defaults to '/'."),
			"id":      schemaString("Box id."),
			"label":   schemaString("New label (optional)."),
			"x":       schemaNumber("New x (optional)."),
			"y":       schemaNumber("New y (optional)."),
			"sides":   schemaNumber("Optional shape: 3=triangle, 4=rectangle, 5=pentagon, 6=hexagon."),
			"palette": schemaNumber("Optional palette index 1..9."),
			"font":    schemaNumber("Optional font-size step 1..9."),
		}, []string{"id"})

	addTool("delete_box",
		"Delete a box (and all incident edges plus its submap subtree).",
		map[string]any{
			"path": schemaString("Map path. Defaults to '/'."),
			"id":   schemaString("Box id."),
		}, []string{"id"})

	addTool("add_edge",
		"Add an edge between two box ids in the same map. Replaces any prior edge between the same pair (edges are undirected).",
		map[string]any{
			"path":       schemaString("Map path. Defaults to '/'."),
			"from":       schemaString("Source box id."),
			"to":         schemaString("Target box id."),
			"fromHandle": schemaString("Source handle code (t, r, b, l, tl, tr, bl, br). Optional."),
			"toHandle":   schemaString("Target handle code. Optional."),
		}, []string{"from", "to"})

	addTool("delete_edge",
		"Delete the edge between two box ids in the same map.",
		map[string]any{
			"path": schemaString("Map path. Defaults to '/'."),
			"from": schemaString("Source box id."),
			"to":   schemaString("Target box id."),
		}, []string{"from", "to"})

	addTool("add_text",
		"Add a free-floating text label.",
		map[string]any{
			"path":  schemaString("Map path. Defaults to '/'."),
			"label": schemaString("Text content."),
			"x":     schemaNumber("X coordinate."),
			"y":     schemaNumber("Y coordinate."),
		}, []string{"label", "x", "y"})

	addTool("add_line",
		"Add a static line segment.",
		map[string]any{
			"path": schemaString("Map path. Defaults to '/'."),
			"x1":   schemaNumber("Start x."),
			"y1":   schemaNumber("Start y."),
			"x2":   schemaNumber("End x."),
			"y2":   schemaNumber("End y."),
		}, []string{"x1", "y1", "x2", "y2"})

	addTool("add_stroke",
		"Add a freehand brush stroke as a polyline. Provide at least two [x, y] points.",
		map[string]any{
			"path": schemaString("Map path. Defaults to '/'."),
			"points": map[string]any{
				"type":        "array",
				"description": "Array of [x, y] coordinate pairs in canvas space, in stroke order.",
				"items": map[string]any{
					"type":     "array",
					"items":    map[string]any{"type": "number"},
					"minItems": 2,
					"maxItems": 2,
				},
				"minItems": 2,
			},
		}, []string{"points"})

	return tools
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
	if serveCfg == nil || serveCfg.WebhookURL == "" {
		return nil, fmt.Errorf("share is unconfigured: --share-webhook missing")
	}

	var graphCopy Graph
	if err := workspaces.With(wsID, func(ws *Workspace) error {
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

	req, err := http.NewRequest(http.MethodPost, serveCfg.WebhookURL, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if serveCfg.WebhookSecret != "" {
		req.Header.Set("Authorization", "Bearer "+serveCfg.WebhookSecret)
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
