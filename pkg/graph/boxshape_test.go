package graph

import (
	"strings"
	"testing"
)

// The `boxshape <id> <shape>` directive tags a box with a non-default
// silhouette (1 = hexagon; 2-9 reserved). It follows the box block so
// older binaries unaware of shapes still parse the geometry cleanly.
func TestParseBoxshapeDirective(t *testing.T) {
	cases := []struct {
		name      string
		input     string
		wantShape int
	}{
		{"absent defaults to rectangle", "box b1 hi 0 0\n", 0},
		{"hexagon", "box b1 hi 0 0\nboxshape b1 1\n", 1},
		{"reserved value stored", "box b1 hi 0 0\nboxshape b1 7\n", 7},
		// 0 is the default-rectangle sentinel; ignore it rather than
		// carry garbage (mirrors linestyle's out-of-range skip).
		{"zero ignored", "box b1 hi 0 0\nboxshape b1 0\n", 0},
		{"out of range ignored", "box b1 hi 0 0\nboxshape b1 12\n", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, err := Parse(tc.input)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if got := g.Maps[0].Boxes[0].Shape; got != tc.wantShape {
				t.Fatalf("shape: got %d, want %d", got, tc.wantShape)
			}
		})
	}
}

func TestParseBoxshapeErrors(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantSub string
	}{
		{"missing args", "box b1 hi 0 0\nboxshape b1\n", "boxshape needs"},
		{"non-numeric shape", "box b1 hi 0 0\nboxshape b1 hex\n", "bad boxshape"},
		{"unknown box", "box b1 hi 0 0\nboxshape nope 1\n", "unknown box"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse(tc.input)
			if err == nil {
				t.Fatal("expected parse error")
			}
			if !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("error %q should contain %q", err, tc.wantSub)
			}
		})
	}
}

// Serializer places boxshape directly after the box block and before
// the anchor directive — the exact slot the TS serializer
// (src/graph/serialize.ts) uses, so the two outputs stay
// byte-identical.
func TestSerializeBoxshapePlacement(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path: "/",
		Boxes: []Box{
			{ID: "b1", Label: "rect", X: 0, Y: 0, Anchor: true},
			{ID: "b2", Label: "hex", X: 10, Y: 20, Shape: 1},
		},
	}}}
	got := Serialize(g)
	want := "box b1 rect 0 0\n" +
		"box b2 hex 10 20\n" +
		"boxshape b2 1\n" +
		"anchor b1\n"
	if got != want {
		t.Fatalf("serialize:\ngot:\n%swant:\n%s", got, want)
	}
}

func TestBoxshapeRoundTrip(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path: "/",
		Boxes: []Box{
			{ID: "b1", Label: "hex", X: 1, Y: 2, Shape: 1},
			{ID: "b2", Label: "rect", X: 3, Y: 4},
		},
	}}}
	out, err := Parse(Serialize(g))
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if out.Maps[0].Boxes[0].Shape != 1 || out.Maps[0].Boxes[1].Shape != 0 {
		t.Fatalf("shape lost in round trip: %+v", out.Maps[0].Boxes)
	}
}
