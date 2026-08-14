package flowgo

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This file targets dispatchToolSession (mcp.go) — the seam between the
// JSON-RPC transport and the tool actions. The action functions
// themselves are covered elsewhere (mcp_test.go et al.); here the unit
// under test is the routing: raw-argument decoding, the serve-mode tool
// switch, workspace resolution, and the local-mode read/write wrappers
// with their error plumbing (the outer updateFile error vs. the tool's
// own inner error are distinct paths and both must surface).

// dispatchSeed is the on-disk fixture for local-mode dispatch tests:
// one of every entity type, so every update_*/delete_* tool has a real
// target and every add_* tool exercises id-minting next to existing ids
// (per feedback: exercise real parsed files, not synthetic structs).
const dispatchSeed = `node b1 one 0 0
node b2 two 300 0
edge b1 b2
text t1 note 10 200
line l1 0 0 100 100
stroke s1 0,0 10,10
`

// withLocalFile configures the package for single-file (local) mode
// against a seeded temp .flowgo and restores the prior package config
// afterwards — cfg is a package-level var (state.go), so tests that
// flip it must undo that for whichever test runs next.
func withLocalFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mindmap.flowgo")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{LocalFile: path})
	return path
}

// mustJSON marshals tool arguments the way a real MCP client would put
// them on the wire, so numbers arrive as float64 and nested arrays as
// []any — the exact shapes the arg helpers must tolerate.
func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal args: %v", err)
	}
	return b
}

// TestDispatchToolSession_LocalMode_EveryToolReachesItsHandler drives
// every entry of the toolActions table through dispatchTool in local
// mode. Post-conditions are asserted via readFile — i.e. against what
// was actually persisted to disk, not the in-memory result — because
// the read-only/mutating split inside dispatchToolSession is exactly
// the thing this test exists to pin: a mutation routed down the
// read-only path would "succeed" and silently never hit the file.
func TestDispatchToolSession_LocalMode_EveryToolReachesItsHandler(t *testing.T) {
	cases := []struct {
		tool         string
		args         map[string]any
		wantText     string // exact tool-result text ("" = don't pin)
		wantContains string // substring check for JSON payloads
		verify       func(t *testing.T, g Graph)
	}{
		{
			tool:         "get_state",
			args:         map[string]any{},
			wantContains: `"one"`,
			verify: func(t *testing.T, g Graph) {
				// Read-only: the seeded graph must be untouched.
				if len(g.Maps[0].Boxes) != 2 || len(g.Maps[0].Edges) != 1 {
					t.Fatalf("get_state mutated the graph: %+v", g.Maps[0])
				}
			},
		},
		{
			tool: "set_state",
			args: map[string]any{"graph": map[string]any{
				"maps": []map[string]any{{
					"path":  "/",
					"boxes": []map[string]any{{"id": "n1", "label": "fresh", "x": 0, "y": 0}},
				}},
			}},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps) != 1 || len(g.Maps[0].Boxes) != 1 || g.Maps[0].Boxes[0].ID != "n1" {
					t.Fatalf("set_state did not replace the graph: %+v", g.Maps)
				}
			},
		},
		{
			tool: "add_box",
			args: map[string]any{"label": "three", "x": 600, "y": 0},
			// b1/b2 exist, so the minted id must be b3 — proves the tool
			// ran against the parsed file, not a fresh graph.
			wantText: "b3",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Boxes) != 3 || g.Maps[0].Boxes[2].Label != "three" {
					t.Fatalf("add_box not persisted: %+v", g.Maps[0].Boxes)
				}
			},
		},
		{
			tool:     "update_box",
			args:     map[string]any{"id": "b1", "label": "renamed", "x": 50},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				b := g.Maps[0].Boxes[0]
				// Y untouched: presence-diffing must not zero absent args.
				if b.Label != "renamed" || b.X != 50 || b.Y != 0 {
					t.Fatalf("update_box wrong: %+v", b)
				}
			},
		},
		{
			tool:     "delete_box",
			args:     map[string]any{"id": "b2"},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Boxes) != 1 || g.Maps[0].Boxes[0].ID != "b1" {
					t.Fatalf("delete_box wrong: %+v", g.Maps[0].Boxes)
				}
				// Incident-edge cascade belongs to the action, but the
				// dispatcher must persist the whole mutated graph.
				if len(g.Maps[0].Edges) != 0 {
					t.Fatalf("incident edge survived: %+v", g.Maps[0].Edges)
				}
			},
		},
		{
			tool:     "add_edge",
			args:     map[string]any{"from": "b1", "to": "b2", "label": "owns", "palette": 4},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				// add_edge replaces the seeded b1—b2 edge rather than
				// stacking a duplicate.
				if len(g.Maps[0].Edges) != 1 {
					t.Fatalf("edge not deduplicated: %+v", g.Maps[0].Edges)
				}
				e := g.Maps[0].Edges[0]
				if e.Label != "owns" || e.Palette != 4 {
					t.Fatalf("add_edge wrong: %+v", e)
				}
			},
		},
		{
			tool: "update_edge",
			// Reversed endpoint order: undirected match through dispatch.
			args:     map[string]any{"from": "b2", "to": "b1", "label": "triggers"},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if g.Maps[0].Edges[0].Label != "triggers" {
					t.Fatalf("update_edge wrong: %+v", g.Maps[0].Edges[0])
				}
			},
		},
		{
			tool:     "delete_edge",
			args:     map[string]any{"from": "b1", "to": "b2"},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Edges) != 0 {
					t.Fatalf("edge not deleted: %+v", g.Maps[0].Edges)
				}
			},
		},
		{
			tool:     "add_text",
			args:     map[string]any{"label": "callout", "x": 5, "y": 5},
			wantText: "t2", // t1 exists in the seed
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Texts) != 2 || g.Maps[0].Texts[1].Label != "callout" {
					t.Fatalf("add_text not persisted: %+v", g.Maps[0].Texts)
				}
			},
		},
		{
			tool:     "update_text",
			args:     map[string]any{"id": "t1", "label": "edited"},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if g.Maps[0].Texts[0].Label != "edited" {
					t.Fatalf("update_text wrong: %+v", g.Maps[0].Texts[0])
				}
			},
		},
		{
			tool:     "delete_text",
			args:     map[string]any{"id": "t1"},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Texts) != 0 {
					t.Fatalf("text not deleted: %+v", g.Maps[0].Texts)
				}
			},
		},
		{
			tool:     "add_line",
			args:     map[string]any{"x1": 1, "y1": 2, "x2": 3, "y2": 4},
			wantText: "l2",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Lines) != 2 || g.Maps[0].Lines[1].X2 != 3 {
					t.Fatalf("add_line not persisted: %+v", g.Maps[0].Lines)
				}
			},
		},
		{
			tool:     "update_line",
			args:     map[string]any{"id": "l1", "x2": 500},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if g.Maps[0].Lines[0].X2 != 500 {
					t.Fatalf("update_line wrong: %+v", g.Maps[0].Lines[0])
				}
			},
		},
		{
			tool:     "delete_line",
			args:     map[string]any{"id": "l1"},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Lines) != 0 {
					t.Fatalf("line not deleted: %+v", g.Maps[0].Lines)
				}
			},
		},
		{
			tool:     "add_stroke",
			args:     map[string]any{"points": [][]float64{{0, 0}, {5, 5}}},
			wantText: "s2",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Strokes) != 2 || len(g.Maps[0].Strokes[1].Points) != 2 {
					t.Fatalf("add_stroke not persisted: %+v", g.Maps[0].Strokes)
				}
			},
		},
		{
			tool:     "update_stroke",
			args:     map[string]any{"id": "s1", "palette": 6},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if g.Maps[0].Strokes[0].Palette != 6 {
					t.Fatalf("update_stroke wrong: %+v", g.Maps[0].Strokes[0])
				}
			},
		},
		{
			tool:     "delete_stroke",
			args:     map[string]any{"id": "s1"},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if len(g.Maps[0].Strokes) != 0 {
					t.Fatalf("stroke not deleted: %+v", g.Maps[0].Strokes)
				}
			},
		},
		{
			tool:     "set_default_shape",
			args:     map[string]any{"shape": 2},
			wantText: "ok",
			verify: func(t *testing.T, g Graph) {
				if g.DefaultShape != 2 {
					t.Fatalf("default shape not persisted: %d", g.DefaultShape)
				}
			},
		},
	}

	// Sanity: the table above must stay in lockstep with toolActions —
	// a tool added to the dispatch map without a dispatch-level test
	// here should fail loudly, not silently lose routing coverage.
	covered := map[string]bool{}
	for _, tc := range cases {
		covered[tc.tool] = true
	}
	for name := range toolActions {
		if !covered[name] {
			t.Errorf("toolActions[%q] has no dispatch-level case in this table", name)
		}
	}

	for _, tc := range cases {
		t.Run(tc.tool, func(t *testing.T) {
			withLocalFile(t, dispatchSeed)
			result, err := dispatchTool(tc.tool, mustJSON(t, tc.args))
			if err != nil {
				t.Fatalf("dispatchTool(%s): %v", tc.tool, err)
			}
			got := mcpToolResultText(t, result)
			if tc.wantText != "" && got != tc.wantText {
				t.Fatalf("result text = %q, want %q", got, tc.wantText)
			}
			if tc.wantContains != "" && !strings.Contains(got, tc.wantContains) {
				t.Fatalf("result text %q does not contain %q", got, tc.wantContains)
			}
			// readFile re-reads through the cache/disk path, so this
			// asserts the persisted state, not the in-memory copy the
			// tool happened to mutate.
			g, err := readFile()
			if err != nil {
				t.Fatalf("readFile after %s: %v", tc.tool, err)
			}
			tc.verify(t, g)
		})
	}
}

// TestDispatchToolSession_NilArguments covers the len(raw)==0 branch:
// MCP clients may omit "arguments" entirely, and tools with no required
// args must run against a nil args map rather than erroring.
func TestDispatchToolSession_NilArguments(t *testing.T) {
	withLocalFile(t, dispatchSeed)
	result, err := dispatchTool("get_state", nil)
	if err != nil {
		t.Fatalf("dispatchTool(get_state, nil): %v", err)
	}
	if !strings.Contains(mcpToolResultText(t, result), `"one"`) {
		t.Fatalf("get_state with nil args returned the wrong graph")
	}
}

func TestDispatchToolSession_BadArgumentsJSON(t *testing.T) {
	withLocalFile(t, dispatchSeed)
	_, err := dispatchTool("add_box", json.RawMessage(`{"label":`))
	if err == nil || !strings.Contains(err.Error(), "bad arguments") {
		t.Fatalf("err = %v, want a 'bad arguments' decode error", err)
	}
}

func TestDispatchToolSession_UnknownTool(t *testing.T) {
	withLocalFile(t, dispatchSeed)
	_, err := dispatchTool("does_not_exist", mustJSON(t, map[string]any{}))
	if err == nil || !strings.Contains(err.Error(), "unknown tool: does_not_exist") {
		t.Fatalf("err = %v, want unknown-tool error naming the tool", err)
	}
}

// Serve-only tools must not leak into local mode: outside ServeMode the
// switch is skipped entirely and they fall through to unknown-tool.
func TestDispatchToolSession_ServeOnlyToolsUnknownInLocalMode(t *testing.T) {
	withLocalFile(t, dispatchSeed)
	for _, name := range []string{"start_workspace", "share", "authenticate"} {
		if _, err := dispatchTool(name, mustJSON(t, map[string]any{})); err == nil ||
			!strings.Contains(err.Error(), "unknown tool") {
			t.Errorf("dispatchTool(%s) in local mode: err = %v, want unknown tool", name, err)
		}
	}
}

// A tool's own validation error (inner) must surface verbatim and must
// not write the file — this is the inner-error path of the updateFile
// wrapper, distinct from updateFile failing outright.
func TestDispatchToolSession_LocalMode_InnerToolErrorLeavesFileUntouched(t *testing.T) {
	path := withLocalFile(t, dispatchSeed)
	_, err := dispatchTool("add_box", mustJSON(t, map[string]any{"x": 1, "y": 1}))
	if err == nil || !strings.Contains(err.Error(), "label is required") {
		t.Fatalf("err = %v, want the tool's own 'label is required'", err)
	}
	onDisk, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read file: %v", readErr)
	}
	if string(onDisk) != dispatchSeed {
		t.Fatalf("file changed despite tool error:\n%s", onDisk)
	}
}

// set_state was the one route that could still persist an unknown shape
// id — actSetDefaultShape and the granular shape args already reject
// them via shapeProp, but a raw graph with defaultShape/box shape 7
// sailed through and wrote `defaultshape 7` / `nodeshape n1 7` to the
// file (which every renderer then silently displays as a rectangle).
// validateGraph now gates both fields, so the tool errors and the file
// keeps its old bytes.
func TestDispatchToolSession_LocalMode_SetStateRejectsUnknownShapeIDs(t *testing.T) {
	path := withLocalFile(t, dispatchSeed)
	_, err := dispatchTool("set_state", mustJSON(t, map[string]any{"graph": map[string]any{
		"defaultShape": 7,
		"maps": []map[string]any{{
			"path":  "/",
			"boxes": []map[string]any{{"id": "n1", "label": "x", "x": 0, "y": 0, "shape": 7}},
		}},
	}}))
	if err == nil || !strings.Contains(err.Error(), "graph rejected") {
		t.Fatalf("err = %v, want a 'graph rejected' validation error", err)
	}
	if !strings.Contains(err.Error(), "defaultShape 7") || !strings.Contains(err.Error(), "invalid shape 7") {
		t.Fatalf("err = %v, want both the defaultShape and the box shape named", err)
	}
	onDisk, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read file: %v", readErr)
	}
	if string(onDisk) != dispatchSeed {
		t.Fatalf("unknown shape id reached disk despite rejection:\n%s", onDisk)
	}
}

// When the backing file is missing, both dispatch paths (read-only via
// readFile, mutating via updateFile) must fail before any tool code
// runs — this is the outer-error path where inner stays nil.
func TestDispatchToolSession_LocalMode_MissingFileErrors(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{LocalFile: filepath.Join(t.TempDir(), "does-not-exist.flowgo")})

	if _, err := dispatchTool("get_state", nil); err == nil {
		t.Fatal("get_state on a missing file should error")
	}
	if _, err := dispatchTool("add_box", mustJSON(t, map[string]any{
		"label": "x", "x": 0, "y": 0,
	})); err == nil {
		t.Fatal("add_box on a missing file should error")
	}
}

// ---------------------------------------------------------------------------
// Serve mode: the dispatcher owns workspace resolution (workspace_id →
// WorkspaceManager) and the serve-only tool switch.
// ---------------------------------------------------------------------------

func withServeMode(t *testing.T) {
	t.Helper()
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{ServeMode: true, Workspaces: NewWorkspaceManager(time.Hour)})
}

func TestDispatchToolSession_ServeMode_StartWorkspaceReturnsLiveID(t *testing.T) {
	withServeMode(t)
	result, err := dispatchTool("start_workspace", nil)
	if err != nil {
		t.Fatalf("dispatchTool(start_workspace): %v", err)
	}
	wsID := mcpToolResultText(t, result)
	// The returned id must resolve in the manager — a made-up string
	// here would strand every subsequent tool call in the session.
	if err := cfg.Workspaces.With(wsID, func(ws *Workspace) error { return nil }); err != nil {
		t.Fatalf("returned workspace id %q is not usable: %v", wsID, err)
	}
}

func TestDispatchToolSession_ServeMode_RequiresWorkspaceID(t *testing.T) {
	withServeMode(t)
	// Even the read-only tool goes through workspace resolution in
	// serve mode — there is no ambient graph to fall back to.
	for _, name := range []string{"get_state", "add_box"} {
		_, err := dispatchTool(name, mustJSON(t, map[string]any{
			"label": "x", "x": 0, "y": 0,
		}))
		if err == nil || !strings.Contains(err.Error(), "workspace_id is required") {
			t.Errorf("dispatchTool(%s) without workspace_id: err = %v, want workspace_id-required", name, err)
		}
	}
}

func TestDispatchToolSession_ServeMode_UnknownWorkspaceID(t *testing.T) {
	withServeMode(t)
	_, err := dispatchTool("add_box", mustJSON(t, map[string]any{
		"workspace_id": "ws-nope", "label": "x", "x": 0, "y": 0,
	}))
	if err == nil || !strings.Contains(err.Error(), "workspace not found") {
		t.Fatalf("err = %v, want workspace-not-found from the manager", err)
	}
}

func TestDispatchToolSession_ServeMode_MutationLandsInNamedWorkspace(t *testing.T) {
	withServeMode(t)
	wsA := cfg.Workspaces.Start()
	wsB := cfg.Workspaces.Start()

	result, err := dispatchTool("add_box", mustJSON(t, map[string]any{
		"workspace_id": wsA, "label": "hello", "x": 10, "y": 20,
	}))
	if err != nil {
		t.Fatalf("dispatchTool(add_box): %v", err)
	}
	if got := mcpToolResultText(t, result); got != "b1" {
		t.Fatalf("minted id = %q, want b1 in a fresh workspace", got)
	}

	// The mutation must land in wsA and only wsA — routing to the wrong
	// workspace is the worst failure mode multi-tenancy can have.
	if err := cfg.Workspaces.With(wsA, func(ws *Workspace) error {
		if len(ws.Graph.Maps[0].Boxes) != 1 || ws.Graph.Maps[0].Boxes[0].Label != "hello" {
			t.Errorf("workspace A graph wrong: %+v", ws.Graph.Maps[0].Boxes)
		}
		return nil
	}); err != nil {
		t.Fatalf("With(wsA): %v", err)
	}
	if err := cfg.Workspaces.With(wsB, func(ws *Workspace) error {
		if len(ws.Graph.Maps[0].Boxes) != 0 {
			t.Errorf("mutation leaked into workspace B: %+v", ws.Graph.Maps[0].Boxes)
		}
		return nil
	}); err != nil {
		t.Fatalf("With(wsB): %v", err)
	}

	// And a read-only tool through the same path sees it.
	state, err := dispatchTool("get_state", mustJSON(t, map[string]any{"workspace_id": wsA}))
	if err != nil {
		t.Fatalf("dispatchTool(get_state): %v", err)
	}
	if !strings.Contains(mcpToolResultText(t, state), `"hello"`) {
		t.Fatalf("get_state did not read back the workspace mutation")
	}
}

func TestDispatchToolSession_ServeMode_InnerToolErrorSurfaces(t *testing.T) {
	withServeMode(t)
	wsID := cfg.Workspaces.Start()
	_, err := dispatchTool("add_box", mustJSON(t, map[string]any{
		"workspace_id": wsID, "x": 0, "y": 0,
	}))
	if err == nil || !strings.Contains(err.Error(), "label is required") {
		t.Fatalf("err = %v, want the tool's inner error, not a swallowed nil", err)
	}
}

// share must route through the serve-mode switch (not toolActions) and
// reach the webhook with the named workspace's graph.
func TestDispatchToolSession_ServeMode_ShareRoutesToWebhook(t *testing.T) {
	var gotGraph struct {
		Graph Graph `json:"graph"`
	}
	withServeModeAndWebhook(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotGraph)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "d1", "url": "https://flowgo-map.com/m/d1"})
	})

	wsID := cfg.Workspaces.Start()
	if _, err := dispatchTool("add_box", mustJSON(t, map[string]any{
		"workspace_id": wsID, "label": "shared", "x": 0, "y": 0,
	})); err != nil {
		t.Fatalf("seed workspace via dispatch: %v", err)
	}

	result, err := dispatchTool("share", mustJSON(t, map[string]any{"workspace_id": wsID}))
	if err != nil {
		t.Fatalf("dispatchTool(share): %v", err)
	}
	if len(gotGraph.Graph.Maps) != 1 || len(gotGraph.Graph.Maps[0].Boxes) != 1 ||
		gotGraph.Graph.Maps[0].Boxes[0].Label != "shared" {
		t.Fatalf("webhook received the wrong graph: %+v", gotGraph.Graph)
	}
	if !strings.Contains(mcpToolResultText(t, result), "d1") {
		t.Fatalf("share result missing the webhook's id: %v", result)
	}
}

// authenticate must receive the transport sessionID the dispatcher was
// handed — this is the one serve-mode tool where the session argument
// is load-bearing rather than pass-through.
func TestDispatchToolSession_ThreadsSessionIDToAuthenticate(t *testing.T) {
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {})
	auth.linked["sess-disp"] = Owner{ID: "o-disp", Label: "disp@example.com"}

	result, err := dispatchToolSession(context.Background(), "sess-disp", "authenticate", mustJSON(t, map[string]any{}))
	if err != nil {
		t.Fatalf("dispatchToolSession(authenticate): %v", err)
	}
	if !strings.Contains(mcpToolResultText(t, result), "disp@example.com") {
		t.Fatalf("authenticate did not see the dispatcher's sessionID: %v", result)
	}

	// The session-less wrapper degrades to anonymous: with no header
	// and no workspace_id fallback there is nothing to link.
	if _, err := dispatchTool("authenticate", mustJSON(t, map[string]any{})); err == nil {
		t.Fatal("session-less authenticate with no workspace_id should error")
	}
}
