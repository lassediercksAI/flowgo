package flowgo

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// freshGraph mints a graph with a single root map so every action has
// somewhere to land without first calling actSetState.
func freshGraph() *Graph {
	return &Graph{Maps: []NamedMap{{Path: "/"}}}
}

// TestActAddBox_NormalisesLabel covers label normalisation through the
// MCP add_box action: per-line trimming, internal-whitespace collapse,
// CRLF → LF, and dropping fully-blank leading / trailing lines. Hard
// newlines (Shift+Enter in the editor) are preserved — they round-trip
// through the .flowgo file as a `\n` escape and render as visible
// breaks. Carriage returns still go away because they're never
// meaningful on their own.
func TestActAddBox_NormalisesLabel(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "hello", "hello"},
		{"trims_outer_whitespace", "  hello  ", "hello"},
		{"collapses_internal_runs", "a   b\tc", "a b c"},
		{"preserves_newlines", "run-opencode.sh\nEntry Point", "run-opencode.sh\nEntry Point"},
		{"normalises_crlf_to_lf", "a\r\nb", "a\nb"},
		{"normalises_bare_cr", "a\rb", "a\nb"},
		{"trims_per_line", "  a  \n  b  ", "a\nb"},
		{"keeps_interior_blank_line", "a\n\nb", "a\n\nb"},
		{"drops_leading_trailing_blanks", "\n\nhi\n\n", "hi"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := freshGraph()
			_, err := actAddBox(g, map[string]any{
				"label": tc.in,
				"x":     float64(0),
				"y":     float64(0),
			})
			if err != nil {
				t.Fatalf("actAddBox: %v", err)
			}
			if len(g.Maps[0].Boxes) != 1 {
				t.Fatalf("expected 1 box, got %d", len(g.Maps[0].Boxes))
			}
			got := g.Maps[0].Boxes[0].Label
			if got != tc.want {
				t.Fatalf("label mismatch:\n  got  %q\n  want %q", got, tc.want)
			}
			if strings.ContainsRune(got, '\r') {
				t.Fatalf("normalised label still contains a carriage return: %q", got)
			}
		})
	}
}

func TestActAddBox_RejectsEmptyLabel(t *testing.T) {
	g := freshGraph()
	_, err := actAddBox(g, map[string]any{
		"label": "",
		"x":     float64(0),
		"y":     float64(0),
	})
	if err == nil {
		t.Fatal("expected error for empty label")
	}
}

func TestActAddBox_RejectsWhitespaceOnlyLabel(t *testing.T) {
	// "   \n\t" normalises to "" and should error like an empty label.
	g := freshGraph()
	_, err := actAddBox(g, map[string]any{
		"label": "   \n\t  ",
		"x":     float64(0),
		"y":     float64(0),
	})
	if err == nil {
		t.Fatal("expected error for whitespace-only label")
	}
}

func TestActAddBox_CapsLongLabel(t *testing.T) {
	long := strings.Repeat("x", graph.MaxLabelLen+200)
	g := freshGraph()
	_, err := actAddBox(g, map[string]any{
		"label": long,
		"x":     float64(0),
		"y":     float64(0),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	got := g.Maps[0].Boxes[0].Label
	if len([]rune(got)) > graph.MaxLabelLen {
		t.Fatalf("label not capped: got %d runes, cap %d", len([]rune(got)), graph.MaxLabelLen)
	}
}

func TestActAddBox_AcceptsValidStylingArgs(t *testing.T) {
	g := freshGraph()
	_, err := actAddBox(g, map[string]any{
		"label":   "hi",
		"x":       float64(10),
		"y":       float64(20),
		"palette": float64(7),
		"font":    float64(4),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	b := g.Maps[0].Boxes[0]
	if b.Palette != 7 || b.Font != 4 {
		t.Fatalf("styling round-trip failed: %+v", b)
	}
}

func TestActUpdateBox_NormalisesLabel(t *testing.T) {
	g := freshGraph()
	id, err := actAddBox(g, map[string]any{
		"label": "before",
		"x":     float64(0),
		"y":     float64(0),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	rawID := mcpFirstText(id)
	// Per-line trim + interior \n preserved (Shift+Enter line breaks
	// round-trip through update_box).
	_, err = actUpdateBox(g, map[string]any{
		"id":    rawID,
		"label": "  line one  \n  line two  ",
	})
	if err != nil {
		t.Fatalf("actUpdateBox: %v", err)
	}
	got := g.Maps[0].Boxes[0].Label
	if got != "line one\nline two" {
		t.Fatalf("update label mismatch: %q", got)
	}
}

func TestActAddText_NormalisesLabel(t *testing.T) {
	g := freshGraph()
	_, err := actAddText(g, map[string]any{
		"label": "first\nsecond",
		"x":     float64(0),
		"y":     float64(0),
	})
	if err != nil {
		t.Fatalf("actAddText: %v", err)
	}
	got := g.Maps[0].Texts[0].Label
	// Newlines now persist (rendered as hard breaks); only carriage
	// returns are stripped (normalised to LF first).
	if got != "first\nsecond" {
		t.Fatalf("text label mismatch: %q", got)
	}
	if strings.ContainsRune(got, '\r') {
		t.Fatalf("text label still contains a carriage return: %q", got)
	}
}

func TestActAddBox_RoundTripsThroughSerializeParse(t *testing.T) {
	// End-to-end safety net: a normalised label must always survive
	// serialize → parse without breaking the file format.
	g := freshGraph()
	for _, lbl := range []string{
		"plain",
		"with spaces in it",
		`with "quotes"`,
		"after\nnewline",
		"after\ttab",
	} {
		if _, err := actAddBox(g, map[string]any{
			"label": lbl,
			"x":     float64(0),
			"y":     float64(0),
		}); err != nil {
			t.Fatalf("actAddBox(%q): %v", lbl, err)
		}
	}
	text := serialize(*g)
	round, err := parse(text)
	if err != nil {
		t.Fatalf("parse(serialize(g)) failed: %v\n--- serialised ---\n%s", err, text)
	}
	if len(round.Maps) == 0 || len(round.Maps[0].Boxes) != len(g.Maps[0].Boxes) {
		t.Fatalf("round-trip lost boxes:\n--- serialised ---\n%s", text)
	}
}

// mcpFirstText pulls the first text payload from a tool result, which
// is what add_box returns (the new id wrapped in mcpToolText).
func mcpFirstText(v any) string {
	type content struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type result struct {
		Content []content `json:"content"`
	}
	if r, ok := v.(map[string]any); ok {
		if cs, ok := r["content"].([]map[string]any); ok && len(cs) > 0 {
			if s, ok := cs[0]["text"].(string); ok {
				return s
			}
		}
	}
	// Fall back: tool results are typed structurally, so reach in via
	// reflection-free access on the known shape.
	if r, ok := v.(map[string]any); ok {
		if cs, ok := r["content"].([]any); ok && len(cs) > 0 {
			if c, ok := cs[0].(map[string]any); ok {
				if s, ok := c["text"].(string); ok {
					return s
				}
			}
		}
	}
	return ""
}

// TestActSetState_BackfillsMissingTextID is the direct regression for the
// "locked map.flowgo" bug: a set_state payload with an id-less text would
// serialize as `text  "label" 0 0`, which the parser then rejects on every
// subsequent updateFile() call. The action must synthesise a fresh id so
// the post-state file always re-parses.
func TestActSetState_BackfillsMissingTextID(t *testing.T) {
	g := freshGraph()
	_, err := actSetState(g, map[string]any{
		"graph": map[string]any{
			"maps": []map[string]any{{
				"path": "/",
				"texts": []map[string]any{
					{"label": "hello", "x": 0, "y": 0},
				},
			}},
		},
	})
	if err != nil {
		t.Fatalf("actSetState: %v", err)
	}
	if len(g.Maps) != 1 || len(g.Maps[0].Texts) != 1 {
		t.Fatalf("unexpected graph shape: %+v", g)
	}
	if g.Maps[0].Texts[0].ID == "" {
		t.Fatalf("text id was not backfilled: %+v", g.Maps[0].Texts[0])
	}
	if _, err := parse(serialize(*g)); err != nil {
		t.Fatalf("post-setState graph not re-parseable: %v\n--- serialised ---\n%s", err, serialize(*g))
	}
}

// TestActSetState_BackfillsLineAndStrokeIDs covers the other two record
// types that travel through the serializer's id slot; without backfill
// they would poison the file the same way an empty-id text does.
func TestActSetState_BackfillsLineAndStrokeIDs(t *testing.T) {
	g := freshGraph()
	_, err := actSetState(g, map[string]any{
		"graph": map[string]any{
			"maps": []map[string]any{{
				"path": "/",
				"lines": []map[string]any{
					{"x1": 0, "y1": 0, "x2": 10, "y2": 10},
				},
				"strokes": []map[string]any{
					{"points": [][]float64{{0, 0}, {10, 10}}},
				},
			}},
		},
	})
	if err != nil {
		t.Fatalf("actSetState: %v", err)
	}
	if id := g.Maps[0].Lines[0].ID; id == "" {
		t.Fatalf("line id not backfilled: %+v", g.Maps[0].Lines[0])
	}
	if id := g.Maps[0].Strokes[0].ID; id == "" {
		t.Fatalf("stroke id not backfilled: %+v", g.Maps[0].Strokes[0])
	}
	if _, err := parse(serialize(*g)); err != nil {
		t.Fatalf("post-setState graph not re-parseable: %v", err)
	}
}

// TestActSetState_RejectsInvalidGraph asserts that validation runs after
// backfill and that the in-memory state is left untouched on rejection.
// Without this guarantee, a malformed set_state would still overwrite
// the workspace and undo recoverable state.
func TestActSetState_RejectsInvalidGraph(t *testing.T) {
	g := freshGraph()
	// Pre-seed something that must survive the rejection.
	g.Maps[0].Boxes = append(g.Maps[0].Boxes, graph.Box{ID: "b_pre", Label: "kept", X: 1, Y: 2})

	_, err := actSetState(g, map[string]any{
		"graph": map[string]any{
			"maps": []map[string]any{{
				"path": "/",
				"boxes": []map[string]any{
					{"id": "b1", "label": "a", "x": 0, "y": 0},
				},
				"edges": []map[string]any{
					{"from": "b1", "to": "ghost"},
				},
			}},
		},
	})
	if err == nil {
		t.Fatalf("expected validation error for unknown edge endpoint")
	}
	if !strings.Contains(err.Error(), "graph rejected") {
		t.Fatalf("error missing 'graph rejected' prefix: %v", err)
	}
	if len(g.Maps[0].Boxes) != 1 || g.Maps[0].Boxes[0].ID != "b_pre" {
		t.Fatalf("graph mutated despite rejection: %+v", g.Maps[0].Boxes)
	}
}

// TestSerialize_SynthesisesFallbackIDs is belt-and-suspenders coverage
// independent of actSetState: even if a future code path constructs an
// in-memory record with an empty ID, Serialize must still emit a
// re-parseable file and must not mutate the caller's graph.
func TestSerialize_SynthesisesFallbackIDs(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:    "/",
		Texts:   []graph.Text{{Label: "hi", X: 0, Y: 0}},
		Lines:   []graph.Line{{X1: 0, Y1: 0, X2: 10, Y2: 10}},
		Strokes: []graph.Stroke{{Points: [][]float64{{0, 0}, {10, 10}}}},
	}}}
	out := serialize(g)
	for _, bad := range []string{"text  ", "line  ", "stroke  "} {
		if strings.Contains(out, bad) {
			t.Fatalf("serialize emitted empty-id %q line:\n%s", bad, out)
		}
	}
	round, err := parse(out)
	if err != nil {
		t.Fatalf("serialize output not re-parseable: %v\n%s", err, out)
	}
	if len(round.Maps[0].Texts) != 1 || round.Maps[0].Texts[0].ID == "" {
		t.Fatalf("round-tripped text missing id: %+v", round.Maps[0].Texts)
	}
	if len(round.Maps[0].Lines) != 1 || round.Maps[0].Lines[0].ID == "" {
		t.Fatalf("round-tripped line missing id: %+v", round.Maps[0].Lines)
	}
	if len(round.Maps[0].Strokes) != 1 || round.Maps[0].Strokes[0].ID == "" {
		t.Fatalf("round-tripped stroke missing id: %+v", round.Maps[0].Strokes)
	}
	// Caller's graph must not have been mutated — the synthesis happens
	// at emit time without writing back into the in-memory record.
	if g.Maps[0].Texts[0].ID != "" || g.Maps[0].Lines[0].ID != "" || g.Maps[0].Strokes[0].ID != "" {
		t.Fatalf("Serialize mutated caller's graph: %+v", g.Maps[0])
	}
}

// ---------------------------------------------------------------------------
// MCP ↔ GUI parity coverage. Each entity must have add / update / delete
// reachable as a granular tool; set_state round-tripping is not a substitute.
// These tests are the regression net for the parity audit captured in
// .claude/skills/mcp-parity-qa/SKILL.md.
// ---------------------------------------------------------------------------

// TestParity_AllEntitiesHaveCRUD asserts the toolActions dispatch table
// exposes add_<entity>, update_<entity>, and delete_<entity> for every
// mutable entity type in pkg/graph. Re-flags missing tools loudly so a
// future entity addition can't silently regress the MCP surface.
func TestParity_AllEntitiesHaveCRUD(t *testing.T) {
	for _, entity := range []string{"box", "edge", "text", "line", "stroke"} {
		for _, verb := range []string{"add", "update", "delete"} {
			name := verb + "_" + entity
			if _, ok := toolActions[name]; !ok {
				t.Errorf("toolActions missing %q — entity %q lost %s parity",
					name, entity, verb)
			}
		}
	}
}

// TestParity_SchemaMatchesStruct guards against the "sides" class of
// schema lie: a property advertised in mcpTools() that the underlying
// Go struct does not have. We enumerate the addTool schemas for each
// entity's add_/update_ tools and verify every non-meta property maps
// to a JSON-tagged field on the corresponding graph type.
func TestParity_SchemaMatchesStruct(t *testing.T) {
	// Meta args that are tool-mechanics, not entity fields.
	meta := map[string]bool{
		"path": true, "id": true,
		"from": true, "to": true,
		"workspace_id": true,
	}
	cases := []struct {
		tools  []string
		fields map[string]bool
	}{
		{
			tools:  []string{"add_box", "update_box"},
			fields: jsonFieldSet(graph.Box{}),
		},
		{
			tools:  []string{"add_edge", "update_edge"},
			fields: jsonFieldSet(graph.Edge{}),
		},
		{
			tools:  []string{"add_text", "update_text"},
			fields: jsonFieldSet(graph.Text{}),
		},
		{
			tools:  []string{"add_line", "update_line"},
			fields: jsonFieldSet(graph.Line{}),
		},
		{
			tools:  []string{"add_stroke", "update_stroke"},
			fields: jsonFieldSet(graph.Stroke{}),
		},
	}
	tools := mcpTools()
	byName := map[string]mcpToolDef{}
	for _, td := range tools {
		byName[td.Name] = td
	}
	for _, c := range cases {
		for _, name := range c.tools {
			td, ok := byName[name]
			if !ok {
				t.Errorf("%s missing from mcpTools()", name)
				continue
			}
			props, _ := td.InputSchema["properties"].(map[string]any)
			for prop := range props {
				if meta[prop] {
					continue
				}
				if !c.fields[prop] {
					t.Errorf("%s advertises %q but the backing struct has no such json field — schema lie",
						name, prop)
				}
			}
		}
	}
}

// jsonFieldSet returns the set of json:"name" tags on v's exported
// fields, with the ",omitempty"/etc. suffix stripped. Used by the
// schema-match test to compare advertised properties against the
// authoritative struct.
func jsonFieldSet(v any) map[string]bool {
	out := map[string]bool{}
	rt := reflect.TypeOf(v)
	for i := 0; i < rt.NumField(); i++ {
		tag := rt.Field(i).Tag.Get("json")
		if tag == "" || tag == "-" {
			continue
		}
		if comma := strings.Index(tag, ","); comma >= 0 {
			tag = tag[:comma]
		}
		out[tag] = true
	}
	return out
}

// TestActAddBox_RejectsSidesArg is a focused regression for the
// dropped-sides lie: the old schema advertised a 'sides' parameter the
// action ignored. The fix removed sides from the schema; this test
// pins that 'sides' is not in the advertised properties anymore.
func TestActAddBox_NoSidesInSchema(t *testing.T) {
	for _, td := range mcpTools() {
		if td.Name != "add_box" && td.Name != "update_box" {
			continue
		}
		props, _ := td.InputSchema["properties"].(map[string]any)
		if _, has := props["sides"]; has {
			t.Errorf("%s still advertises 'sides' — Box has no such field", td.Name)
		}
	}
}

// TestActAddBox_AcceptsAnchor covers the new anchor flag on add_box:
// setting it must persist Anchor=true and clear any prior anchor on
// the same map (per-map singleton, mirroring keys.ts toggleAnchor).
func TestActAddBox_AcceptsAnchor(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = append(g.Maps[0].Boxes, graph.Box{
		ID: "b_old", Label: "old", X: 0, Y: 0, Anchor: true,
	})
	id, err := actAddBox(g, map[string]any{
		"label":  "anchored",
		"x":      float64(10),
		"y":      float64(10),
		"anchor": true,
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	rawID := mcpFirstText(id)
	var anchored []string
	for _, b := range g.Maps[0].Boxes {
		if b.Anchor {
			anchored = append(anchored, b.ID)
		}
	}
	if len(anchored) != 1 || anchored[0] != rawID {
		t.Fatalf("anchor singleton broken: %v (expected only %s)", anchored, rawID)
	}
}

// TestActAddBox_AcceptsShape covers the shape flag on add_box:
// 1-3 (hexagon/circle/triangle) must persist as Box.Shape, 0 stays
// the zero-value rectangle, and anything else is rejected — the GUI
// only renders shapes 0-3, so the MCP must not let reserved values in.
func TestActAddBox_AcceptsShape(t *testing.T) {
	g := freshGraph()
	id, err := actAddBox(g, map[string]any{
		"label": "hex",
		"x":     float64(10),
		"y":     float64(20),
		"shape": float64(1),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	rawID := mcpFirstText(id)
	var got *graph.Box
	for i := range g.Maps[0].Boxes {
		if g.Maps[0].Boxes[i].ID == rawID {
			got = &g.Maps[0].Boxes[i]
		}
	}
	if got == nil || got.Shape != 1 {
		t.Fatalf("shape not persisted: %+v", g.Maps[0].Boxes)
	}
	if _, err := actAddBox(g, map[string]any{
		"label": "circle",
		"x":     float64(0),
		"y":     float64(0),
		"shape": float64(2),
	}); err != nil {
		t.Fatalf("shape 2 (circle) must be accepted: %v", err)
	}
	if _, err := actAddBox(g, map[string]any{
		"label": "tri",
		"x":     float64(0),
		"y":     float64(0),
		"shape": float64(3),
	}); err != nil {
		t.Fatalf("shape 3 (triangle) must be accepted: %v", err)
	}
	if _, err := actAddBox(g, map[string]any{
		"label": "bad",
		"x":     float64(0),
		"y":     float64(0),
		"shape": float64(4),
	}); err == nil {
		t.Fatal("expected error for out-of-range shape")
	}
}

func TestActUpdateBox_ShapeSetAndClear(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "b1", Label: "one"}}
	if _, err := actUpdateBox(g, map[string]any{"id": "b1", "shape": float64(1)}); err != nil {
		t.Fatalf("actUpdateBox set: %v", err)
	}
	if g.Maps[0].Boxes[0].Shape != 1 {
		t.Fatalf("shape not set: %+v", g.Maps[0].Boxes[0])
	}
	if _, err := actUpdateBox(g, map[string]any{"id": "b1", "shape": float64(0)}); err != nil {
		t.Fatalf("actUpdateBox clear: %v", err)
	}
	if g.Maps[0].Boxes[0].Shape != 0 {
		t.Fatalf("shape not cleared: %+v", g.Maps[0].Boxes[0])
	}
	if _, err := actUpdateBox(g, map[string]any{"id": "b1", "shape": float64(2)}); err != nil {
		t.Fatalf("shape 2 (circle) must be accepted: %v", err)
	}
	if g.Maps[0].Boxes[0].Shape != 2 {
		t.Fatalf("circle shape not set: %+v", g.Maps[0].Boxes[0])
	}
	if _, err := actUpdateBox(g, map[string]any{"id": "b1", "shape": float64(5)}); err == nil {
		t.Fatal("expected error for reserved shape value")
	}
}

func TestActUpdateBox_AnchorTrueSweepsOthers(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{
		{ID: "b1", Label: "one", Anchor: true},
		{ID: "b2", Label: "two"},
	}
	if _, err := actUpdateBox(g, map[string]any{"id": "b2", "anchor": true}); err != nil {
		t.Fatalf("actUpdateBox: %v", err)
	}
	if g.Maps[0].Boxes[0].Anchor || !g.Maps[0].Boxes[1].Anchor {
		t.Fatalf("anchor not transferred: %+v", g.Maps[0].Boxes)
	}
}

func TestActUpdateBox_AnchorFalseClearsSelf(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "b1", Label: "one", Anchor: true}}
	if _, err := actUpdateBox(g, map[string]any{"id": "b1", "anchor": false}); err != nil {
		t.Fatalf("actUpdateBox: %v", err)
	}
	if g.Maps[0].Boxes[0].Anchor {
		t.Fatalf("anchor not cleared: %+v", g.Maps[0].Boxes[0])
	}
}

func TestActUpdateText_MutatesAllFields(t *testing.T) {
	g := freshGraph()
	id, err := actAddText(g, map[string]any{
		"label": "first", "x": float64(1), "y": float64(2),
	})
	if err != nil {
		t.Fatalf("actAddText: %v", err)
	}
	rawID := mcpFirstText(id)
	if _, err := actUpdateText(g, map[string]any{
		"id":      rawID,
		"label":   "second",
		"x":       float64(10),
		"y":       float64(20),
		"palette": float64(3),
		"font":    float64(4),
	}); err != nil {
		t.Fatalf("actUpdateText: %v", err)
	}
	got := g.Maps[0].Texts[0]
	if got.Label != "second" || got.X != 10 || got.Y != 20 || got.Palette != 3 || got.Font != 4 {
		t.Fatalf("update_text round-trip wrong: %+v", got)
	}
}

func TestActDeleteText(t *testing.T) {
	g := freshGraph()
	id, err := actAddText(g, map[string]any{"label": "x", "x": float64(0), "y": float64(0)})
	if err != nil {
		t.Fatalf("actAddText: %v", err)
	}
	if _, err := actDeleteText(g, map[string]any{"id": mcpFirstText(id)}); err != nil {
		t.Fatalf("actDeleteText: %v", err)
	}
	if len(g.Maps[0].Texts) != 0 {
		t.Fatalf("text not deleted: %+v", g.Maps[0].Texts)
	}
	if _, err := actDeleteText(g, map[string]any{"id": "nonexistent"}); err == nil {
		t.Fatalf("expected error deleting missing text")
	}
}

func TestActDeleteBox(t *testing.T) {
	g := freshGraph()
	idA, err := actAddBox(g, map[string]any{"label": "a", "x": float64(0), "y": float64(0)})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	idB, err := actAddBox(g, map[string]any{"label": "b", "x": float64(100), "y": float64(0)})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	boxA := mcpFirstText(idA)
	boxB := mcpFirstText(idB)
	if _, err := actAddEdge(g, map[string]any{"from": boxA, "to": boxB}); err != nil {
		t.Fatalf("actAddEdge: %v", err)
	}

	if _, err := actDeleteBox(g, map[string]any{"id": boxA}); err != nil {
		t.Fatalf("actDeleteBox: %v", err)
	}
	if len(g.Maps[0].Boxes) != 1 || g.Maps[0].Boxes[0].ID != boxB {
		t.Fatalf("box not deleted, or wrong box removed: %+v", g.Maps[0].Boxes)
	}
	if len(g.Maps[0].Edges) != 0 {
		t.Fatalf("deleting a box should also delete edges touching it: %+v", g.Maps[0].Edges)
	}

	if _, err := actDeleteBox(g, map[string]any{"id": "nonexistent"}); err == nil {
		t.Fatal("expected error deleting a missing box")
	}
	if _, err := actDeleteBox(g, map[string]any{}); err == nil {
		t.Fatal("expected error when id is missing")
	}
}

// TestActDeleteBox_RemovesNestedSubmaps covers the cascading-delete
// behavior in actDeleteBox: deleting a node also deletes its submap
// and any deeper maps nested under it (by path prefix), not just the
// node itself and its edges.
func TestActDeleteBox_RemovesNestedSubmaps(t *testing.T) {
	g := freshGraph()
	id, err := actAddBox(g, map[string]any{"label": "parent", "x": float64(0), "y": float64(0)})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	boxID := mcpFirstText(id)
	subPath := joinPath("/", boxID)
	deeperPath := subPath + "/child"
	g.Maps = append(g.Maps,
		NamedMap{Path: subPath, Boxes: []Box{{ID: "s1", Label: "in submap"}}},
		NamedMap{Path: deeperPath, Boxes: []Box{{ID: "s2", Label: "even deeper"}}},
	)
	// An unrelated map sharing a string prefix (but not a path
	// component) must survive — hasPrefix's "+\"/\"" check is what
	// this guards against a naive strings.HasPrefix would miss.
	siblingLikePath := subPath + "-unrelated"
	g.Maps = append(g.Maps, NamedMap{Path: siblingLikePath, Boxes: []Box{{ID: "s3", Label: "unrelated"}}})

	if _, err := actDeleteBox(g, map[string]any{"id": boxID}); err != nil {
		t.Fatalf("actDeleteBox: %v", err)
	}

	var remaining []string
	for _, m := range g.Maps {
		remaining = append(remaining, m.Path)
	}
	for _, gone := range []string{subPath, deeperPath} {
		for _, p := range remaining {
			if p == gone {
				t.Errorf("map %q should have been deleted along with its parent box, remaining maps: %v", gone, remaining)
			}
		}
	}
	found := false
	for _, p := range remaining {
		if p == siblingLikePath {
			found = true
		}
	}
	if !found {
		t.Errorf("map %q shares a string prefix but is not actually nested under the deleted box — it should survive; remaining maps: %v", siblingLikePath, remaining)
	}
}

func TestActDeleteEdge(t *testing.T) {
	g := freshGraph()
	if _, err := actAddEdge(g, map[string]any{"from": "a", "to": "b"}); err != nil {
		t.Fatalf("actAddEdge: %v", err)
	}
	if _, err := actDeleteEdge(g, map[string]any{"from": "a", "to": "b"}); err != nil {
		t.Fatalf("actDeleteEdge: %v", err)
	}
	if len(g.Maps[0].Edges) != 0 {
		t.Fatalf("edge not deleted: %+v", g.Maps[0].Edges)
	}
}

func TestActDeleteEdge_IsUndirected(t *testing.T) {
	g := freshGraph()
	if _, err := actAddEdge(g, map[string]any{"from": "a", "to": "b"}); err != nil {
		t.Fatalf("actAddEdge: %v", err)
	}
	// Delete specifying the endpoints in the opposite order.
	if _, err := actDeleteEdge(g, map[string]any{"from": "b", "to": "a"}); err != nil {
		t.Fatalf("actDeleteEdge (reversed order): %v", err)
	}
	if len(g.Maps[0].Edges) != 0 {
		t.Fatalf("edge not deleted when endpoints were reversed: %+v", g.Maps[0].Edges)
	}
}

func TestActDeleteEdge_MissingArgsOrEdge(t *testing.T) {
	g := freshGraph()
	if _, err := actDeleteEdge(g, map[string]any{"from": "a"}); err == nil {
		t.Fatal("expected error when 'to' is missing")
	}
	if _, err := actDeleteEdge(g, map[string]any{"from": "a", "to": "b"}); err == nil {
		t.Fatal("expected error deleting a nonexistent edge")
	}
}

func TestActGetState(t *testing.T) {
	g := freshGraph()
	if _, err := actAddBox(g, map[string]any{"label": "hi", "x": float64(1), "y": float64(2)}); err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	result, err := actGetState(g, nil)
	if err != nil {
		t.Fatalf("actGetState: %v", err)
	}
	var got Graph
	if err := json.Unmarshal([]byte(mcpToolResultText(t, result)), &got); err != nil {
		t.Fatalf("unmarshal actGetState result: %v", err)
	}
	if len(got.Maps) != 1 || len(got.Maps[0].Boxes) != 1 || got.Maps[0].Boxes[0].Label != "hi" {
		t.Fatalf("actGetState result = %+v, want the same graph passed in", got)
	}
}

func TestIsReadOnlyTool(t *testing.T) {
	if !isReadOnlyTool("get_state") {
		t.Error("get_state should be read-only")
	}
	for _, name := range []string{"add_box", "delete_box", "set_state", "share", "create_map", ""} {
		if isReadOnlyTool(name) {
			t.Errorf("%q should not be classified as read-only", name)
		}
	}
}

func TestShareWorkspace(t *testing.T) {
	var gotBody struct {
		Graph graph.Graph `json:"graph"`
	}
	withServeModeAndWebhook(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "xyz", "url": "https://flowgo-map.com/m/xyz"})
	})

	wsID := cfg.Workspaces.Start()
	if err := cfg.Workspaces.With(wsID, func(ws *Workspace) error {
		ws.Graph.Maps[0].Boxes = append(ws.Graph.Maps[0].Boxes, Box{ID: "b1", Label: "shared box"})
		return nil
	}); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}

	result, err := shareWorkspace(context.Background(), "", map[string]any{"workspace_id": wsID})
	if err != nil {
		t.Fatalf("shareWorkspace: %v", err)
	}
	if len(gotBody.Graph.Maps) != 1 || len(gotBody.Graph.Maps[0].Boxes) != 1 || gotBody.Graph.Maps[0].Boxes[0].Label != "shared box" {
		t.Fatalf("webhook did not receive the workspace's own graph: %+v", gotBody.Graph)
	}
	var out struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(mcpToolResultText(t, result)), &out); err != nil {
		t.Fatalf("unmarshal shareWorkspace result: %v", err)
	}
	if out.ID != "xyz" {
		t.Errorf("shareWorkspace result id = %q, want xyz", out.ID)
	}
}

func TestShareWorkspace_RequiresWorkspaceID(t *testing.T) {
	if _, err := shareWorkspace(context.Background(), "", map[string]any{}); err == nil {
		t.Fatal("expected error when workspace_id is missing")
	}
}

func TestShareWorkspace_UnknownWorkspaceID(t *testing.T) {
	withServeModeAndWebhook(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("webhook should never be called for an unknown workspace")
	})
	if _, err := shareWorkspace(context.Background(), "", map[string]any{"workspace_id": "ws-does-not-exist"}); err == nil {
		t.Fatal("expected error for an unknown workspace id")
	}
}

func TestFilterBoxesEdgesMaps(t *testing.T) {
	boxes := []Box{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	got := filterBoxes(boxes, func(b Box) bool { return b.ID != "b" })
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "c" {
		t.Fatalf("filterBoxes = %+v, want [a c]", got)
	}

	edges := []Edge{{From: "a", To: "b"}, {From: "b", To: "c"}}
	gotE := filterEdges(edges, func(e Edge) bool { return e.From != "a" })
	if len(gotE) != 1 || gotE[0].From != "b" {
		t.Fatalf("filterEdges = %+v, want [{b c}]", gotE)
	}

	maps := []NamedMap{{Path: "/"}, {Path: "/x"}, {Path: "/y"}}
	gotM := filterMaps(maps, func(m NamedMap) bool { return m.Path != "/x" })
	if len(gotM) != 2 || gotM[0].Path != "/" || gotM[1].Path != "/y" {
		t.Fatalf("filterMaps = %+v, want [/ /y]", gotM)
	}

	// Filtering to zero results is the actAddEdge dedup path's normal
	// case (removing a would-be-duplicate edge before re-adding it) —
	// make sure it doesn't panic or return a stale/aliased slice.
	if empty := filterBoxes(boxes, func(Box) bool { return false }); len(empty) != 0 {
		t.Fatalf("filterBoxes with an always-false predicate = %+v, want empty", empty)
	}
}

func TestJoinPath(t *testing.T) {
	cases := []struct{ parent, id, want string }{
		{"/", "a", "/a"},
		{"/a", "b", "/a/b"},
		{"/a/b", "c", "/a/b/c"},
	}
	for _, tc := range cases {
		if got := joinPath(tc.parent, tc.id); got != tc.want {
			t.Errorf("joinPath(%q, %q) = %q, want %q", tc.parent, tc.id, got, tc.want)
		}
	}
}

func TestHasPrefix(t *testing.T) {
	cases := []struct {
		s, prefix string
		want      bool
	}{
		{"/a/b", "/a/", true},
		{"/a", "/a/", false},
		{"/ab", "/a/", false},
		{"/a/", "/a/", true},
		{"", "/a/", false},
		{"/a", "", true},
	}
	for _, tc := range cases {
		if got := hasPrefix(tc.s, tc.prefix); got != tc.want {
			t.Errorf("hasPrefix(%q, %q) = %v, want %v", tc.s, tc.prefix, got, tc.want)
		}
	}
}

func TestWriteMCPError(t *testing.T) {
	w := httptest.NewRecorder()
	writeMCPError(w, json.RawMessage(`7`), -32700, "boom")

	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var resp mcpResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp.JSONRPC != "2.0" || string(resp.ID) != "7" {
		t.Errorf("response envelope = %+v, want jsonrpc 2.0 / id 7", resp)
	}
	if resp.Error == nil || resp.Error.Code != -32700 || resp.Error.Message != "boom" {
		t.Errorf("response error = %+v, want code -32700 message boom", resp.Error)
	}
}

func TestMcpToolError(t *testing.T) {
	result := mcpToolError("something went wrong")
	if isErr, _ := result["isError"].(bool); !isErr {
		t.Errorf("isError = %v, want true", result["isError"])
	}
	if mcpToolResultText(t, result) != "something went wrong" {
		t.Errorf("text = %q, want the original message", mcpToolResultText(t, result))
	}
}

func TestUpdateFileAndReadFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/mindmap.flowgo"
	if err := os.WriteFile(path, []byte("node b1 hello 0 0\n"), 0644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{LocalFile: path})

	g, err := readFile()
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if len(g.Maps[0].Boxes) != 1 || g.Maps[0].Boxes[0].Label != "hello" {
		t.Fatalf("readFile graph = %+v, want the seeded box", g.Maps[0])
	}

	updated, err := updateFile(func(g *Graph) error {
		g.Maps[0].Boxes[0].Label = "updated"
		return nil
	})
	if err != nil {
		t.Fatalf("updateFile: %v", err)
	}
	if updated.Maps[0].Boxes[0].Label != "updated" {
		t.Fatalf("updateFile did not return the mutated graph: %+v", updated)
	}

	// The mutation must actually have been persisted to disk, not just
	// returned in memory.
	reread, err := readFile()
	if err != nil {
		t.Fatalf("readFile after update: %v", err)
	}
	if reread.Maps[0].Boxes[0].Label != "updated" {
		t.Fatalf("update was not persisted to disk: %+v", reread.Maps[0])
	}
}

func TestUpdateFile_MutatorErrorDoesNotWriteFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/mindmap.flowgo"
	original := "node b1 hello 0 0\n"
	if err := os.WriteFile(path, []byte(original), 0644); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{LocalFile: path})

	sentinel := errFromFn{}
	if _, err := updateFile(func(g *Graph) error { return sentinel }); err != sentinel {
		t.Fatalf("updateFile error = %v, want the mutator's own error", err)
	}

	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(onDisk) != original {
		t.Errorf("file was modified despite the mutator erroring:\n  got  %q\n  want %q", onDisk, original)
	}
}

func TestUpdateFile_MissingFile(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{LocalFile: t.TempDir() + "/does-not-exist.flowgo"})

	if _, err := readFile(); err == nil {
		t.Fatal("expected an error reading a missing file")
	}
	if _, err := updateFile(func(g *Graph) error { return nil }); err == nil {
		t.Fatal("expected an error updating a missing file")
	}
}

func TestActUpdateLine_StyleAndMids(t *testing.T) {
	g := freshGraph()
	id, err := actAddLine(g, map[string]any{
		"x1": float64(0), "y1": float64(0), "x2": float64(100), "y2": float64(100),
	})
	if err != nil {
		t.Fatalf("actAddLine: %v", err)
	}
	rawID := mcpFirstText(id)
	if _, err := actUpdateLine(g, map[string]any{
		"id":      rawID,
		"style":   float64(2),
		"palette": float64(5),
		"mids":    []any{[]any{float64(40), float64(60)}, []any{float64(60), float64(40)}},
	}); err != nil {
		t.Fatalf("actUpdateLine: %v", err)
	}
	got := g.Maps[0].Lines[0]
	if got.Style != 2 || got.Palette != 5 || len(got.Mids) != 2 {
		t.Fatalf("update_line round-trip wrong: %+v", got)
	}
	// Clearing mids: explicit null should empty the slice.
	if _, err := actUpdateLine(g, map[string]any{"id": rawID, "mids": nil}); err != nil {
		t.Fatalf("actUpdateLine(clear mids): %v", err)
	}
	if len(g.Maps[0].Lines[0].Mids) != 0 {
		t.Fatalf("mids not cleared: %+v", g.Maps[0].Lines[0].Mids)
	}
}

func TestActDeleteLine(t *testing.T) {
	g := freshGraph()
	id, err := actAddLine(g, map[string]any{
		"x1": float64(0), "y1": float64(0), "x2": float64(1), "y2": float64(1),
	})
	if err != nil {
		t.Fatalf("actAddLine: %v", err)
	}
	if _, err := actDeleteLine(g, map[string]any{"id": mcpFirstText(id)}); err != nil {
		t.Fatalf("actDeleteLine: %v", err)
	}
	if len(g.Maps[0].Lines) != 0 {
		t.Fatalf("line not deleted")
	}
}

func TestActUpdateStroke_Palette(t *testing.T) {
	g := freshGraph()
	id, err := actAddStroke(g, map[string]any{
		"points": []any{[]any{float64(0), float64(0)}, []any{float64(10), float64(10)}},
	})
	if err != nil {
		t.Fatalf("actAddStroke: %v", err)
	}
	if _, err := actUpdateStroke(g, map[string]any{
		"id":      mcpFirstText(id),
		"palette": float64(7),
	}); err != nil {
		t.Fatalf("actUpdateStroke: %v", err)
	}
	if g.Maps[0].Strokes[0].Palette != 7 {
		t.Fatalf("stroke palette not updated: %+v", g.Maps[0].Strokes[0])
	}
}

func TestActDeleteStroke(t *testing.T) {
	g := freshGraph()
	id, err := actAddStroke(g, map[string]any{
		"points": []any{[]any{float64(0), float64(0)}, []any{float64(5), float64(5)}},
	})
	if err != nil {
		t.Fatalf("actAddStroke: %v", err)
	}
	if _, err := actDeleteStroke(g, map[string]any{"id": mcpFirstText(id)}); err != nil {
		t.Fatalf("actDeleteStroke: %v", err)
	}
	if len(g.Maps[0].Strokes) != 0 {
		t.Fatalf("stroke not deleted")
	}
}

func TestActUpdateEdge_PaletteAndHandles(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "a", Label: "A"}, {ID: "b", Label: "B"}}
	if _, err := actAddEdge(g, map[string]any{"from": "a", "to": "b"}); err != nil {
		t.Fatalf("actAddEdge: %v", err)
	}
	// Pass reversed direction to confirm the undirected match works.
	if _, err := actUpdateEdge(g, map[string]any{
		"from":       "b",
		"to":         "a",
		"palette":    float64(6),
		"fromHandle": "t",
		"toHandle":   "b",
	}); err != nil {
		t.Fatalf("actUpdateEdge: %v", err)
	}
	e := g.Maps[0].Edges[0]
	// from/to in args were reversed relative to storage, so the handles
	// should land on the correctly-mapped storage endpoints (a -> b in
	// storage; "fromHandle"=t in args targets storage 'b' end).
	if e.Palette != 6 || e.ToHandle != "t" || e.FromHandle != "b" {
		t.Fatalf("update_edge mapping wrong: %+v", e)
	}
}

func TestActAddEdge_PaletteAtCreate(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "a", Label: "A"}, {ID: "b", Label: "B"}}
	if _, err := actAddEdge(g, map[string]any{"from": "a", "to": "b", "palette": float64(4)}); err != nil {
		t.Fatalf("actAddEdge: %v", err)
	}
	if g.Maps[0].Edges[0].Palette != 4 {
		t.Fatalf("create-time palette dropped: %+v", g.Maps[0].Edges[0])
	}
}

// ---------------------------------------------------------------------------
// Discoverability: a competent MCP client should be able to bootstrap
// understanding from the initialize response and one resource fetch.
// These tests guard the highest-leverage agent-facing copy.
// ---------------------------------------------------------------------------

// TestInitialize_HasInstructions runs the initialize JSON-RPC method
// through the same handler the network surfaces and asserts the
// response carries a non-empty instructions string that touches the
// concepts an agent needs to operate sensibly (paths, coordinates,
// the 1..9 scales). Lossy keyword presence is intentional — the goal
// is to prevent the field from regressing to empty or to a stub, not
// to pin exact prose.
// TestMCPHandler_HTTPLayer exercises MCPHandler/handleMCP as real HTTP
// requests (httptest, not calling handleMCP directly) — the transport
// layer (GET server-info, POST JSON-RPC dispatch, malformed-JSON
// parse errors, and fire-and-forget notifications) had no coverage at
// all; every other MCP test in this file calls the action functions
// directly and never goes through the HTTP handler itself.
func TestMCPHandler_HTTPLayer(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{})

	t.Run("GET returns server info", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/mcp", nil)
		w := httptest.NewRecorder()
		MCPHandler(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
		var body struct{ Name string }
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if body.Name != "flowgo" {
			t.Errorf("name = %q, want flowgo", body.Name)
		}
	})

	t.Run("unsupported method rejected", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/mcp", nil)
		w := httptest.NewRecorder()
		MCPHandler(w, req)
		if w.Code != http.StatusMethodNotAllowed {
			t.Errorf("status = %d, want %d", w.Code, http.StatusMethodNotAllowed)
		}
	})

	// DELETE is the streamable-HTTP transport's "terminate this
	// session" verb, not an unsupported method — it must succeed even
	// with no auth backend wired (nothing to unlink).
	t.Run("DELETE terminates the session", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/mcp", nil)
		req.Header.Set(mcpSessionHeader, "some-session")
		w := httptest.NewRecorder()
		MCPHandler(w, req)
		if w.Code != http.StatusNoContent {
			t.Errorf("status = %d, want %d", w.Code, http.StatusNoContent)
		}
	})

	t.Run("POST initialize dispatches through JSON-RPC", func(t *testing.T) {
		body := strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)
		req := httptest.NewRequest(http.MethodPost, "/mcp", body)
		w := httptest.NewRecorder()
		MCPHandler(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
		var resp mcpResp
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if resp.Error != nil {
			t.Fatalf("unexpected error: %+v", resp.Error)
		}
		if string(resp.ID) != "1" {
			t.Errorf("id = %s, want 1", resp.ID)
		}
	})

	t.Run("malformed JSON body produces a parse-error response, not a panic", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("not json"))
		w := httptest.NewRecorder()
		MCPHandler(w, req)
		var resp mcpResp
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if resp.Error == nil || resp.Error.Code != -32700 {
			t.Errorf("error = %+v, want a -32700 parse error", resp.Error)
		}
	})

	t.Run("a notification (no id) gets a 202 with no body dispatch error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
		w := httptest.NewRecorder()
		MCPHandler(w, req)
		if w.Code != http.StatusAccepted {
			t.Errorf("status = %d, want %d", w.Code, http.StatusAccepted)
		}
	})
}

func TestInitialize_HasInstructions(t *testing.T) {
	rr := mcpCall(t, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	inst, _ := rr["result"].(map[string]any)["instructions"].(string)
	if inst == "" {
		t.Fatalf("initialize.result.instructions is empty — first thing most MCP clients show the model is missing")
	}
	for _, must := range []string{"path", "coordinate", "palette", "edge", "submap"} {
		if !strings.Contains(strings.ToLower(inst), must) {
			t.Errorf("instructions missing the word %q — agents won't learn this concept from the primer", must)
		}
	}
	caps, _ := rr["result"].(map[string]any)["capabilities"].(map[string]any)
	if _, ok := caps["resources"]; !ok {
		t.Errorf("initialize.capabilities does not advertise resources — clients won't try resources/list")
	}
}

func TestResourcesList_IncludesAbout(t *testing.T) {
	rr := mcpCall(t, `{"jsonrpc":"2.0","id":1,"method":"resources/list","params":{}}`)
	res, _ := rr["result"].(map[string]any)["resources"].([]any)
	var found bool
	for _, r := range res {
		m, _ := r.(map[string]any)
		if m["uri"] == "flowgo://about" {
			found = true
			if m["mimeType"] == "" || m["name"] == "" || m["description"] == "" {
				t.Errorf("flowgo://about resource entry missing required metadata: %+v", m)
			}
		}
	}
	if !found {
		t.Fatalf("resources/list did not include flowgo://about; got %v", res)
	}
}

func TestResourcesRead_AboutReturnsRefDoc(t *testing.T) {
	rr := mcpCall(t, `{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"flowgo://about"}}`)
	contents, _ := rr["result"].(map[string]any)["contents"].([]any)
	if len(contents) == 0 {
		t.Fatalf("resources/read returned no contents")
	}
	first, _ := contents[0].(map[string]any)
	text, _ := first["text"].(string)
	// Spot-check that the doc covers the topics a tool-description
	// can't carry: vestigial slots, handle codes, implicit submaps.
	lower := strings.ToLower(text)
	for _, must := range []string{"vestigial", "tl tr bl br", "implicitly", "linestyle"} {
		if !strings.Contains(lower, must) {
			t.Errorf("flowgo://about missing concept %q — the long-form doc is the only place this lives", must)
		}
	}
}

func TestResourcesRead_UnknownURIError(t *testing.T) {
	rr := mcpCall(t, `{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"flowgo://does-not-exist"}}`)
	if _, hasErr := rr["error"]; !hasErr {
		t.Fatalf("expected JSON-RPC error for unknown resource uri, got %v", rr)
	}
}

// mcpCall runs a single JSON-RPC request through handleMCP and returns
// the parsed response. Shares the same HTTP plumbing as a real client
// so the test catches transport-level regressions (wrong Content-Type,
// missing field, schema drift) on top of action-level correctness.
func mcpCall(t *testing.T, body string) map[string]any {
	t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleMCP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("handleMCP returned status %d, body %s", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response not valid JSON: %v\nbody: %s", err, w.Body.String())
	}
	return out
}

// TestStyleProp_Range covers the shared 1..9 styling validator: values
// 2..9 pass through verbatim, 0/1 collapse to 0 (the default-omitted
// storage value), everything else errors.
func TestStyleProp_Range(t *testing.T) {
	for v, want := range map[int]int{0: 0, 1: 0, 2: 2, 5: 5, 9: 9} {
		got, err := styleProp(float64(v), "palette")
		if err != nil {
			t.Errorf("styleProp(%d): unexpected error %v", v, err)
		}
		if got != want {
			t.Errorf("styleProp(%d) = %d, want %d", v, got, want)
		}
	}
	for _, bad := range []int{-1, 10, 99} {
		if _, err := styleProp(float64(bad), "palette"); err == nil {
			t.Errorf("styleProp(%d): expected error", bad)
		}
	}
}

// Circles and triangles are fixed-size like hexagons: w/h aimed at
// them must be rejected on add and update, and becoming one clears a
// previously pinned size. Guards the shape!=0 generalisation — a
// regression back to shape==1 lets circles carry pinned sizes.
func TestShapeFixedSizeGuardsCoverCircleAndTriangle(t *testing.T) {
	g := freshGraph()
	if _, err := actAddBox(g, map[string]any{
		"label": "c", "x": float64(0), "y": float64(0),
		"shape": float64(2), "w": float64(200), "h": float64(100),
	}); err == nil {
		t.Fatal("add_box: w/h alongside shape=2 must error")
	}
	g.Maps[0].Boxes = []graph.Box{{ID: "b1", Label: "one", W: 200, H: 120}}
	if _, err := actUpdateBox(g, map[string]any{
		"id": "b1", "shape": float64(3), "w": float64(300), "h": float64(200),
	}); err == nil {
		t.Fatal("update_box: w/h alongside shape=3 must error")
	}
	if _, err := actUpdateBox(g, map[string]any{"id": "b1", "shape": float64(2)}); err != nil {
		t.Fatalf("becoming a circle: %v", err)
	}
	if g.Maps[0].Boxes[0].W != 0 || g.Maps[0].Boxes[0].H != 0 {
		t.Fatalf("becoming a circle must clear the pinned size: %+v", g.Maps[0].Boxes[0])
	}
}

// withServeModeAndWebhook Configures the package for serve mode against
// a fake webhook standing in for the website's /api/snapshot, and
// restores the prior package-level cfg on cleanup. cfg is a shared
// package var (see state.go), so every test that mutates it must undo
// that before returning control to whichever test runs next.
func withServeModeAndWebhook(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	webhook := httptest.NewServer(handler)
	t.Cleanup(webhook.Close)
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{
		ServeMode:          true,
		Workspaces:         NewWorkspaceManager(time.Hour),
		ShareWebhookURL:    webhook.URL,
		ShareWebhookSecret: "test-secret",
	})
	return webhook
}

// mcpToolResultText unwraps the {"content":[{"type":"text","text":...}]}
// envelope every tool result is wrapped in (see mcpToolText/mcpToolJSON)
// and returns the raw text payload.
func mcpToolResultText(t *testing.T, result any) string {
	t.Helper()
	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("result is not a map[string]any: %#v", result)
	}
	content, ok := m["content"].([]map[string]any)
	if !ok || len(content) == 0 {
		t.Fatalf("result has no content: %#v", result)
	}
	text, ok := content[0]["text"].(string)
	if !ok {
		t.Fatalf("content[0].text is not a string: %#v", content[0])
	}
	return text
}

// TestCreateMapOneShot covers brain#211: create_map(flowgo_text) should
// parse + validate the text, POST it to the configured webhook with
// the bearer secret, and surface the webhook's {id, url} response —
// all without a prior start_workspace call.
func TestCreateMapOneShot(t *testing.T) {
	var gotAuth string
	var gotBody struct {
		Graph                graph.Graph `json:"graph"`
		WorkspaceFingerprint string      `json:"workspace_fingerprint"`
	}
	withServeModeAndWebhook(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("webhook: decode request body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id": "abc123", "url": "https://flowgo-map.com/m/abc123",
		})
	})

	args, _ := json.Marshal(map[string]string{"flowgo_text": "node b1 hi 10 20\nnode b2 there 220 20\nedge b1 b2\n"})
	result, err := dispatchTool("create_map", args)
	if err != nil {
		t.Fatalf("dispatchTool(create_map): %v", err)
	}

	if gotAuth != "Bearer test-secret" {
		t.Errorf("webhook Authorization = %q, want %q", gotAuth, "Bearer test-secret")
	}
	if len(gotBody.Graph.Maps) != 1 || len(gotBody.Graph.Maps[0].Boxes) != 2 || gotBody.Graph.Maps[0].Boxes[0].Label != "hi" {
		t.Fatalf("webhook did not receive the parsed graph: %+v", gotBody.Graph)
	}

	var out struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(mcpToolResultText(t, result)), &out); err != nil {
		t.Fatalf("unmarshal tool result: %v", err)
	}
	if out.ID != "abc123" || out.URL != "https://flowgo-map.com/m/abc123" {
		t.Errorf("tool result = %+v, want id=abc123 url=.../m/abc123", out)
	}
}

func TestCreateMapRequiresFlowgoText(t *testing.T) {
	withServeModeAndWebhook(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("webhook should never be called when flowgo_text is missing")
	})
	if _, err := dispatchTool("create_map", json.RawMessage(`{}`)); err == nil {
		t.Fatal("expected an error for missing flowgo_text")
	}
}

func TestCreateMapRejectsInvalidSyntax(t *testing.T) {
	withServeModeAndWebhook(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("webhook should never be called for unparseable text")
	})
	args, _ := json.Marshal(map[string]string{"flowgo_text": "not a real directive at all\n"})
	_, err := dispatchTool("create_map", args)
	if err == nil || !strings.Contains(err.Error(), "invalid .flowgo text") {
		t.Fatalf("dispatchTool(create_map) error = %v, want it to mention invalid .flowgo text", err)
	}
}

func TestCreateMapRejectsSemanticallyInvalidGraph(t *testing.T) {
	withServeModeAndWebhook(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("webhook should never be called for a graph that fails validation")
	})
	// Syntactically fine, semantically broken: an edge to a node that
	// doesn't exist on this map.
	args, _ := json.Marshal(map[string]string{"flowgo_text": "node b1 hi 0 0\nedge b1 nonexistent\n"})
	_, err := dispatchTool("create_map", args)
	if err == nil || !strings.Contains(err.Error(), "graph rejected") {
		t.Fatalf("dispatchTool(create_map) error = %v, want it to mention graph rejected", err)
	}
}

// TestCreateMapNotAvailableOutsideServeMode confirms create_map is a
// hosted-only tool: in local (non-serve) mode it's simply unknown,
// same as start_workspace/share.
func TestCreateMapNotAvailableOutsideServeMode(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{}) // ServeMode defaults false

	args, _ := json.Marshal(map[string]string{"flowgo_text": "node b1 hi 0 0\n"})
	_, err := dispatchTool("create_map", args)
	if err == nil || !strings.Contains(err.Error(), "unknown tool") {
		t.Fatalf("dispatchTool(create_map) outside serve mode: err = %v, want unknown tool", err)
	}
}

func TestMcpToolsListIncludesCreateMapOnlyInServeMode(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { cfg = orig })

	Configure(Config{ServeMode: true, Workspaces: NewWorkspaceManager(time.Hour)})
	found := false
	for _, tool := range mcpTools() {
		if tool.Name == "create_map" {
			found = true
			req, _ := tool.InputSchema["required"].([]string)
			if len(req) != 1 || req[0] != "flowgo_text" {
				t.Errorf("create_map required = %v, want [flowgo_text]", req)
			}
		}
	}
	if !found {
		t.Error("create_map missing from tools/list in serve mode")
	}

	Configure(Config{}) // local mode
	for _, tool := range mcpTools() {
		if tool.Name == "create_map" {
			t.Error("create_map should not be listed outside serve mode")
		}
	}
}
