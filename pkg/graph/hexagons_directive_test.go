package graph

import (
	"strings"
	"testing"
)

// The document-level `hexagons on` directive: a .flowgo file can ask
// the editor to open with the hexagon setting enabled.

func TestParseHexagonsDirective(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"hexagons on\nbox b1 x 0 0\n", true},
		{"hexagons 1\nbox b1 x 0 0\n", true},
		{"hexagons true\nbox b1 x 0 0\n", true},
		{"hexagons\nbox b1 x 0 0\n", true}, // bare = on
		{"hexagons off\nbox b1 x 0 0\n", false},
		{"hexagons 0\nbox b1 x 0 0\n", false},
		{"box b1 x 0 0\n", false}, // absent = no preference
	}
	for _, tc := range cases {
		g, err := Parse(tc.in)
		if err != nil {
			t.Fatalf("parse %q: %v", tc.in, err)
		}
		if g.Hexagons != tc.want {
			t.Errorf("parse %q: Hexagons = %v, want %v", tc.in, g.Hexagons, tc.want)
		}
	}
}

func TestParseHexagonsRejectsGarbage(t *testing.T) {
	_, err := Parse("hexagons maybe\n")
	if err == nil || !strings.Contains(err.Error(), "on or off") {
		t.Fatalf("expected on-or-off error, got %v", err)
	}
}

func TestSerializeHexagonsRoundTrip(t *testing.T) {
	in := Graph{
		Version:  "1.2.3",
		Hexagons: true,
		Maps: []NamedMap{{
			Path:  "/",
			Boxes: []Box{{ID: "b1", Label: "x"}},
		}},
	}
	out := Serialize(in)
	if !strings.HasPrefix(out, "version 1.2.3\nhexagons on\n") {
		t.Fatalf("hexagons directive must follow version:\n%s", out)
	}
	back, err := Parse(out)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if !back.Hexagons {
		t.Fatal("round-trip lost the hexagons flag")
	}
	// Unset flag emits nothing.
	in.Hexagons = false
	if strings.Contains(Serialize(in), "hexagons") {
		t.Fatal("unset flag must not emit a directive")
	}
}
