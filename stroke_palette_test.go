package main

import (
	"strings"
	"testing"
)

// Parse should treat the token directly after the id as an optional
// palette when it has no comma. Points always carry a comma so the two
// forms are unambiguous; this test pins that disambiguation.
func TestParseStrokePalette(t *testing.T) {
	cases := []struct {
		name        string
		line        string
		wantPalette int
		wantPoints  int
	}{
		{"no palette", "stroke s1 100,200 200,300", 0, 2},
		{"palette 2", "stroke s1 2 100,200 200,300", 2, 2},
		{"palette 9", "stroke s1 9 1,2 3,4 5,6", 9, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, err := parse(tc.line)
			if err != nil {
				t.Fatalf("parse %q: %v", tc.line, err)
			}
			if len(g.Maps) != 1 || len(g.Maps[0].Strokes) != 1 {
				t.Fatalf("expected exactly one stroke: %+v", g)
			}
			s := g.Maps[0].Strokes[0]
			if s.Palette != tc.wantPalette {
				t.Fatalf("palette: got %d, want %d", s.Palette, tc.wantPalette)
			}
			if len(s.Points) != tc.wantPoints {
				t.Fatalf("points: got %d, want %d", len(s.Points), tc.wantPoints)
			}
		})
	}
}

// A non-integer palette token (still no comma) is a parse error rather
// than a silent fallback — otherwise typos in hand-edited files would
// silently drop the first point.
func TestParseStrokeBadPalette(t *testing.T) {
	_, err := parse("stroke s1 abc 100,200 200,300")
	if err == nil {
		t.Fatal("expected parse error for non-numeric palette token")
	}
	if !strings.Contains(err.Error(), "palette") {
		t.Fatalf("error should mention palette, got: %v", err)
	}
}

// Default palette (0) must not emit any palette token; styled palettes
// (2-9) emit their number between the id and the first point.
func TestSerializeStrokePalette(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path: "/",
		Strokes: []Stroke{
			{ID: "a", Points: [][]float64{{0, 0}, {1, 1}}, Palette: 0},
			{ID: "b", Points: [][]float64{{0, 0}, {1, 1}}, Palette: 3},
			{ID: "c", Points: [][]float64{{0, 0}, {1, 1}}, Palette: 9},
		},
	}}}
	out := serialize(g)
	wantLines := []string{
		"stroke a 0,0 1,1",
		"stroke b 3 0,0 1,1",
		"stroke c 9 0,0 1,1",
	}
	for _, want := range wantLines {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
}

// Round-trip pins parse(serialize(parse(x))) == parse(x) for every
// palette index, including 0 (default — no token emitted).
func TestStrokePaletteRoundTrip(t *testing.T) {
	for _, p := range []int{0, 2, 3, 4, 5, 6, 7, 8, 9} {
		in := Graph{Maps: []NamedMap{{
			Path: "/",
			Strokes: []Stroke{{
				ID:      "s1",
				Points:  [][]float64{{1, 2}, {3, 4}},
				Palette: p,
			}},
		}}}
		out, err := parse(serialize(in))
		if err != nil {
			t.Fatalf("palette %d re-parse: %v", p, err)
		}
		if got := out.Maps[0].Strokes[0].Palette; got != p {
			t.Fatalf("palette %d: round-tripped as %d", p, got)
		}
	}
}

// Edges accept an optional trailing palette token after the two
// endpoints. Round-tripping through parse(serialize(g)) preserves the
// palette for every legal value, including 0 (no token emitted).
func TestEdgePaletteRoundTrip(t *testing.T) {
	for _, p := range []int{0, 2, 5, 9} {
		in := Graph{Maps: []NamedMap{{
			Path:  "/",
			Boxes: []Box{{ID: "a", Label: "a"}, {ID: "b", Label: "b"}},
			Edges: []Edge{{From: "a", To: "b", Palette: p}},
		}}}
		out, err := parse(serialize(in))
		if err != nil {
			t.Fatalf("palette %d re-parse: %v", p, err)
		}
		if got := out.Maps[0].Edges[0].Palette; got != p {
			t.Fatalf("palette %d: round-tripped as %d", p, got)
		}
	}
}

// Edge palette stays a trailing token so older files (without it) keep
// parsing. With handles the form becomes `edge a:tl b:br 5`.
func TestSerializeEdgePalette(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "a", Label: "a"}, {ID: "b", Label: "b"}},
		Edges: []Edge{
			{From: "a", To: "b"},
			{From: "a", To: "b", Palette: 5},
			{From: "a", To: "b", FromHandle: "tl", ToHandle: "br", Palette: 7},
		},
	}}}
	out := serialize(g)
	for _, want := range []string{
		"edge a b\n",
		"edge a b 5\n",
		"edge a:tl b:br 7\n",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
}

// Standalone lines also accept an optional palette as the 7th token,
// after the four coords.
func TestLinePaletteRoundTrip(t *testing.T) {
	for _, p := range []int{0, 2, 4, 9} {
		in := Graph{Maps: []NamedMap{{
			Path:  "/",
			Lines: []Line{{ID: "l1", X1: 0, Y1: 0, X2: 10, Y2: 10, Palette: p}},
		}}}
		out, err := parse(serialize(in))
		if err != nil {
			t.Fatalf("palette %d re-parse: %v", p, err)
		}
		if got := out.Maps[0].Lines[0].Palette; got != p {
			t.Fatalf("palette %d: round-tripped as %d", p, got)
		}
	}
}

func TestSerializeLinePalette(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path: "/",
		Lines: []Line{
			{ID: "l1", X1: 0, Y1: 0, X2: 1, Y2: 1},
			{ID: "l2", X1: 0, Y1: 0, X2: 1, Y2: 1, Palette: 4},
		},
	}}}
	out := serialize(g)
	for _, want := range []string{"line l1 0 0 1 1\n", "line l2 0 0 1 1 4\n"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
}

// Palette 1 is the "no class applied" sentinel for box/text and is
// rejected by validPalette there. Strokes share the rule so the data
// model stays uniform — only 0 or 2..9 are allowed.
func TestValidateStrokePalette(t *testing.T) {
	good := []int{0, 2, 9}
	bad := []int{1, -1, 10, 99}
	for _, p := range good {
		g := Graph{Maps: []NamedMap{{
			Path:    "/",
			Strokes: []Stroke{{ID: "s1", Points: [][]float64{{0, 0}, {1, 1}}, Palette: p}},
		}}}
		if errs := validateGraph(g); len(errs) != 0 {
			t.Fatalf("palette %d rejected unexpectedly: %v", p, errs)
		}
	}
	for _, p := range bad {
		g := Graph{Maps: []NamedMap{{
			Path:    "/",
			Strokes: []Stroke{{ID: "s1", Points: [][]float64{{0, 0}, {1, 1}}, Palette: p}},
		}}}
		errs := validateGraph(g)
		var found bool
		for _, e := range errs {
			if strings.Contains(e.Error(), "palette") {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("palette %d should have produced a palette validation error, got: %v", p, errs)
		}
	}
}
