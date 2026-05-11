package main

import (
	"strings"
	"testing"

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
		"sides":   float64(5),
		"palette": float64(7),
		"font":    float64(4),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	b := g.Maps[0].Boxes[0]
	if b.Sides != 5 || b.Palette != 7 || b.Font != 4 {
		t.Fatalf("styling round-trip failed: %+v", b)
	}
}

func TestActAddBox_RejectsInvalidSides(t *testing.T) {
	g := freshGraph()
	_, err := actAddBox(g, map[string]any{
		"label": "hi",
		"x":     float64(0),
		"y":     float64(0),
		"sides": float64(7),
	})
	if err == nil {
		t.Fatal("expected error for sides=7")
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
