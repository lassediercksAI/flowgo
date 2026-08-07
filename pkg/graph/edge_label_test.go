package graph

import (
	"strings"
	"testing"
)

// Edge labels (brain#266) are the fifth positional token on the `edge`
// line, behind the palette. These tests pin the token layout, the
// sentinel-palette rule, and the round-trip of hostile label content —
// the class of bug brain#245 found, where a label serialized to
// something the tokenizer could not read back.

func TestParseEdgeLabel(t *testing.T) {
	g, err := Parse("node a x 0 0\nnode b y 0 0\nedge a b 1 \"depends on\"\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	e := g.Maps[0].Edges[0]
	if e.Label != "depends on" {
		t.Fatalf("label = %q, want %q", e.Label, "depends on")
	}
	if e.Palette != 0 {
		t.Fatalf("sentinel palette 1 must not become a real palette, got %d", e.Palette)
	}
}

func TestParseEdgeLabelWithPalette(t *testing.T) {
	g, err := Parse("node a x 0 0\nnode b y 0 0\nedge a:r b:l 3 owns\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	e := g.Maps[0].Edges[0]
	if e.Palette != 3 || e.Label != "owns" || e.FromHandle != "r" || e.ToHandle != "l" {
		t.Fatalf("got %+v", e)
	}
}

func TestSerializeEdgeLabelSentinelPalette(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "a"}, {ID: "b"}},
		Edges: []Edge{{From: "a", To: "b", Label: "depends on"}},
	}}}
	out := Serialize(g)
	if !strings.Contains(out, "edge a b 1 \"depends on\"\n") {
		t.Fatalf("want sentinel palette + quoted label, got:\n%s", out)
	}
}

func TestSerializeEdgeWithoutLabelUnchanged(t *testing.T) {
	// The whole point of hanging the label off slot 5: documents that
	// predate the feature keep their exact bytes.
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "a"}, {ID: "b"}, {ID: "c"}},
		Edges: []Edge{
			{From: "a", To: "b"},
			{From: "b", To: "c", Palette: 4},
		},
	}}}
	out := Serialize(g)
	if !strings.Contains(out, "edge a b\n") {
		t.Fatalf("unlabelled unstyled edge must emit two tokens only:\n%s", out)
	}
	if !strings.Contains(out, "edge b c 4\n") {
		t.Fatalf("unlabelled palette edge must not gain a token:\n%s", out)
	}
}

// Round-trip every value that has historically been able to break the
// format: empty, whitespace-only, quotes, backslashes, newlines,
// carriage returns, unicode, and a bare integer that could be confused
// with a palette.
func TestEdgeLabelHostileRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // "" means "same as in"
	}{
		{name: "empty", in: ""},
		{name: "space only", in: " "},
		// The serializer preserves a tab verbatim inside quotes;
		// collapsing it is NormalizeLabel's job, not the format's.
		{name: "tab only", in: "\t"},
		{name: "quote", in: `say "hi"`},
		{name: "backslash", in: `a\b`},
		{name: "trailing backslash", in: `a\`},
		{name: "newline", in: "two\nlines"},
		{name: "crlf", in: "two\r\nlines", want: "two\nlines"},
		{name: "bare cr", in: "two\rlines", want: "two\nlines"},
		{name: "unicode", in: "läuft → ✅"},
		{name: "looks like a palette", in: "3"},
		{name: "looks like a directive", in: "edge a b"},
		{name: "quote only", in: `"`},
		{name: "colon", in: "a:b"},
		{name: "leading hash", in: "# not a comment"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := tc.want
			if want == "" {
				want = tc.in
			}
			g := Graph{Maps: []NamedMap{{
				Path:  "/",
				Boxes: []Box{{ID: "a"}, {ID: "b"}},
				Edges: []Edge{{From: "a", To: "b", Label: tc.in}},
			}}}
			out := Serialize(g)
			back, err := Parse(out)
			if err != nil {
				t.Fatalf("re-parse failed for %q:\n%s\nerr: %v", tc.in, out, err)
			}
			if len(back.Maps) != 1 || len(back.Maps[0].Edges) != 1 {
				t.Fatalf("edge lost in round-trip for %q:\n%s", tc.in, out)
			}
			got := back.Maps[0].Edges[0].Label
			if got != want {
				t.Fatalf("label %q round-tripped to %q, want %q\nfile:\n%s", tc.in, got, want, out)
			}
			// Second pass must be byte-stable: the on-disk form is a
			// fixed point, so ordinary editing can never drift.
			if again := Serialize(back); again != out {
				t.Fatalf("not a fixed point for %q:\nfirst:\n%s\nsecond:\n%s", tc.in, out, again)
			}
		})
	}
}

// An empty label must not emit a token at all. brain#245's bug was an
// empty label serializing to `""`, which the tokenizer dropped, leaving
// a directive with the wrong arity.
func TestEdgeEmptyLabelEmitsNoToken(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "a"}, {ID: "b"}},
		Edges: []Edge{{From: "a", To: "b", Label: "", Palette: 5}},
	}}}
	out := Serialize(g)
	if !strings.Contains(out, "edge a b 5\n") {
		t.Fatalf("want bare palette edge:\n%s", out)
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "edge ") && strings.Contains(line, `""`) {
			t.Fatalf("empty label must not be written at all: %q", line)
		}
	}
}

// A hand-written file MAY still contain the empty token; it must read
// back as "no label" rather than exploding.
func TestParseExplicitEmptyEdgeLabel(t *testing.T) {
	g, err := Parse("node a x 0 0\nnode b y 0 0\nedge a b 1 \"\"\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if l := g.Maps[0].Edges[0].Label; l != "" {
		t.Fatalf("label = %q, want empty", l)
	}
	if out := Serialize(g); !strings.Contains(out, "edge a b\n") {
		t.Fatalf("empty label must not survive a rewrite:\n%s", out)
	}
}

func TestValidateWritableRejectsEdgeLabelCR(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "a"}, {ID: "b"}},
		Edges: []Edge{{From: "a", To: "b", Label: "two\rlines"}},
	}}}
	errs := ValidateWritable(g)
	if len(errs) == 0 {
		t.Fatal("expected a carriage-return complaint")
	}
	if !strings.Contains(errs[0].Error(), "carriage return") {
		t.Fatalf("unexpected error: %v", errs[0])
	}
}

func TestValidateEdgeLabelLengthCap(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "a"}, {ID: "b"}},
		Edges: []Edge{{From: "a", To: "b", Label: strings.Repeat("x", MaxLabelLen+1)}},
	}}}
	found := false
	for _, err := range Validate(g) {
		if strings.Contains(err.Error(), "label is") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a label-length complaint, got %v", Validate(g))
	}
}

// A labelled edge must survive alongside every other per-edge field.
func TestEdgeLabelWithHandlesAndPalette(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "a"}, {ID: "b"}},
		Edges: []Edge{{From: "a", FromHandle: "tr", To: "b", ToHandle: "bl", Palette: 9, Label: "why not"}},
	}}}
	out := Serialize(g)
	if !strings.Contains(out, "edge a:tr b:bl 9 \"why not\"\n") {
		t.Fatalf("unexpected serialization:\n%s", out)
	}
	back, err := Parse(out)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	got := back.Maps[0].Edges[0]
	if got.FromHandle != "tr" || got.ToHandle != "bl" || got.Palette != 9 || got.Label != "why not" {
		t.Fatalf("round-trip lost a field: %+v", got)
	}
}
