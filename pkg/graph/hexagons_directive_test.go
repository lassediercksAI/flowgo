package graph

import (
	"strings"
	"testing"
)

// Document-level default shape: the `defaultshape <n>` directive, plus
// the legacy `hexagons on` directive it superseded (still parsed as
// DefaultShape=1, never re-emitted).

func TestParseLegacyHexagonsDirective(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"hexagons on\nbox b1 x 0 0\n", 1},
		{"hexagons 1\nbox b1 x 0 0\n", 1},
		{"hexagons true\nbox b1 x 0 0\n", 1},
		{"hexagons\nbox b1 x 0 0\n", 1}, // bare = on
		{"hexagons off\nbox b1 x 0 0\n", 0},
		{"hexagons 0\nbox b1 x 0 0\n", 0},
		{"box b1 x 0 0\n", 0}, // absent = rectangle default
		// hexagons never clobbers an explicit defaultshape, in either order.
		{"defaultshape 2\nhexagons on\nbox b1 x 0 0\n", 2},
		{"hexagons on\ndefaultshape 3\nbox b1 x 0 0\n", 3},
		{"defaultshape 2\nhexagons off\nbox b1 x 0 0\n", 2},
	}
	for _, tc := range cases {
		g, err := Parse(tc.in)
		if err != nil {
			t.Fatalf("parse %q: %v", tc.in, err)
		}
		if g.DefaultShape != tc.want {
			t.Errorf("parse %q: DefaultShape = %d, want %d", tc.in, g.DefaultShape, tc.want)
		}
	}
}

func TestParseHexagonsRejectsGarbage(t *testing.T) {
	_, err := Parse("hexagons maybe\n")
	if err == nil || !strings.Contains(err.Error(), "on or off") {
		t.Fatalf("expected on-or-off error, got %v", err)
	}
}

func TestParseDefaultShapeDirective(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"defaultshape 1\nbox b1 x 0 0\n", 1},
		{"defaultshape 2\nbox b1 x 0 0\n", 2},
		{"defaultshape 3\nbox b1 x 0 0\n", 3},
		{"defaultshape 0\nbox b1 x 0 0\n", 0},  // explicit zero = ignored
		{"defaultshape 42\nbox b1 x 0 0\n", 0}, // out of range = ignored
	}
	for _, tc := range cases {
		g, err := Parse(tc.in)
		if err != nil {
			t.Fatalf("parse %q: %v", tc.in, err)
		}
		if g.DefaultShape != tc.want {
			t.Errorf("parse %q: DefaultShape = %d, want %d", tc.in, g.DefaultShape, tc.want)
		}
	}
}

func TestParseDefaultShapeRejectsGarbage(t *testing.T) {
	if _, err := Parse("defaultshape\n"); err == nil {
		t.Fatal("expected error for missing value")
	}
	if _, err := Parse("defaultshape lots\n"); err == nil {
		t.Fatal("expected error for non-numeric value")
	}
}

func TestSerializeDefaultShapeRoundTrip(t *testing.T) {
	in := Graph{
		Version:      "1.2.3",
		DefaultShape: 3,
		Maps: []NamedMap{{
			Path:  "/",
			Boxes: []Box{{ID: "b1", Label: "x"}},
		}},
	}
	out := Serialize(in)
	if !strings.HasPrefix(out, "version 1.2.3\ndefaultshape 3\n") {
		t.Fatalf("defaultshape directive must follow version:\n%s", out)
	}
	back, err := Parse(out)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if back.DefaultShape != 3 {
		t.Fatalf("round-trip lost the default shape: got %d", back.DefaultShape)
	}
	// Zero emits nothing, and legacy input re-serializes as defaultshape.
	in.DefaultShape = 0
	if strings.Contains(Serialize(in), "defaultshape") {
		t.Fatal("zero default shape must not emit a directive")
	}
	legacy, err := Parse("version 1.2.3\nhexagons on\nbox b1 x 0 0\n")
	if err != nil {
		t.Fatalf("legacy parse: %v", err)
	}
	reser := Serialize(legacy)
	if strings.Contains(reser, "hexagons") {
		t.Fatalf("legacy hexagons must not be re-emitted:\n%s", reser)
	}
	if !strings.Contains(reser, "defaultshape 1\n") {
		t.Fatalf("legacy hexagons must migrate to defaultshape 1:\n%s", reser)
	}
}
