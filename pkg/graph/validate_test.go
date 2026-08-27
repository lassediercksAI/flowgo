package graph

import (
	"os"
	"strings"
	"testing"
)

// TestValidate_CatchesEachViolation is the negative-path counterpart to
// TestMapFlowgoIsValid below: that test only proves a real, valid file
// passes. Before this, Validate/validateMap's ~25 distinct violation
// checks (the entire reason the function exists) had never actually
// been exercised with bad data.
func TestValidate_CatchesEachViolation(t *testing.T) {
	cases := []struct {
		name string
		g    Graph
		want string // substring expected somewhere in the error list
	}{
		{
			name: "no maps at all",
			g:    Graph{},
			want: "no maps",
		},
		{
			name: "invalid map path (missing leading slash)",
			g:    Graph{Maps: []NamedMap{{Path: "a"}}},
			want: "invalid path",
		},
		{
			name: "invalid map path (empty segment)",
			g:    Graph{Maps: []NamedMap{{Path: "/a//b"}}},
			want: "invalid path",
		},
		{
			name: "duplicate map path",
			g: Graph{Maps: []NamedMap{
				{Path: "/", Boxes: []Box{{ID: "b1"}}},
				{Path: "/", Boxes: []Box{{ID: "b2"}}},
			}},
			want: "duplicate",
		},
		{
			name: "orphaned submap: an intermediate parent map was never declared",
			// Box "A" exists on "/", so segment 1 resolves fine and the
			// walk advances to parent "/A" — but "/A" itself was never
			// declared as its own map (only "/A/B/C" was), so segment 2
			// hits the "parent does not exist" branch specifically,
			// distinct from "segment is not a box on its parent".
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "A"}}}, {Path: "/A/B/C", Boxes: []Box{{ID: "x"}}}}},
			want: "parent",
		},
		{
			name: "orphaned submap: segment isn't a box on the parent",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}}}, {Path: "/not-a-box", Boxes: []Box{{ID: "x"}}}}},
			want: "is not a box on",
		},
		{
			name: "empty box id",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: ""}}}}},
			want: "empty id",
		},
		{
			name: "duplicate box id",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}, {ID: "b1"}}}}},
			want: "duplicate box id",
		},
		{
			name: "invalid box palette",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Palette: 1}}}}},
			want: "invalid palette",
		},
		{
			name: "invalid box font",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Font: 99}}}}},
			want: "invalid font",
		},
		{
			// The parser tolerates reserved shape ids in existing files
			// (forward compat), but Validate gates the write boundaries:
			// a caller-supplied graph must not mint `nodeshape b1 7`.
			name: "invalid box shape",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Shape: 7}}}}},
			want: "invalid shape",
		},
		{
			// Same boundary rule for the document-level default: without
			// it, set_state persisted `defaultshape 7` while every
			// renderer silently fell back to a rectangle.
			name: "invalid document defaultShape",
			g:    Graph{DefaultShape: 7, Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}}}}},
			want: "defaultShape 7 is not a known shape",
		},
		{
			name: "box label too long",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: strings.Repeat("x", MaxLabelLen+1)}}}}},
			want: "cap is",
		},
		{
			name: "box label with a carriage return",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: "a\rb"}}}}},
			want: "carriage return",
		},
		{
			name: "edge references an unknown from-box",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}}, Edges: []Edge{{From: "ghost", To: "b1"}}}}},
			want: "references unknown box",
		},
		{
			name: "edge references an unknown to-box",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}}, Edges: []Edge{{From: "b1", To: "ghost"}}}}},
			want: "references unknown box",
		},
		{
			name: "edge self-loop",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}}, Edges: []Edge{{From: "b1", To: "b1"}}}}},
			want: "self-loop",
		},
		{
			name: "edge invalid fromHandle",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}, {ID: "b2"}}, Edges: []Edge{{From: "b1", To: "b2", FromHandle: "nw"}}}}},
			want: "fromHandle",
		},
		{
			name: "edge invalid toHandle",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}, {ID: "b2"}}, Edges: []Edge{{From: "b1", To: "b2", ToHandle: "nw"}}}}},
			want: "toHandle",
		},
		{
			name: "edge invalid palette",
			g:    Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1"}, {ID: "b2"}}, Edges: []Edge{{From: "b1", To: "b2", Palette: 1}}}}},
			want: "invalid palette",
		},
		{
			name: "empty text id",
			g:    Graph{Maps: []NamedMap{{Path: "/", Texts: []Text{{ID: ""}}}}},
			want: "empty id",
		},
		{
			name: "text id collides with another item",
			g:    Graph{Maps: []NamedMap{{Path: "/", Texts: []Text{{ID: "x"}}, Lines: []Line{{ID: "x", X2: 1, Y2: 1}}}}},
			want: "collides with",
		},
		{
			name: "text invalid palette",
			g:    Graph{Maps: []NamedMap{{Path: "/", Texts: []Text{{ID: "t1", Palette: 1}}}}},
			want: "invalid palette",
		},
		{
			name: "text invalid font",
			g:    Graph{Maps: []NamedMap{{Path: "/", Texts: []Text{{ID: "t1", Font: 1}}}}},
			want: "invalid font",
		},
		{
			name: "text label too long",
			g:    Graph{Maps: []NamedMap{{Path: "/", Texts: []Text{{ID: "t1", Label: strings.Repeat("x", MaxLabelLen+1)}}}}},
			want: "cap is",
		},
		{
			name: "text label with a carriage return",
			g:    Graph{Maps: []NamedMap{{Path: "/", Texts: []Text{{ID: "t1", Label: "a\rb"}}}}},
			want: "carriage return",
		},
		{
			name: "empty line id",
			g:    Graph{Maps: []NamedMap{{Path: "/", Lines: []Line{{ID: "", X2: 1, Y2: 1}}}}},
			want: "empty id",
		},
		{
			name: "duplicate line id",
			g:    Graph{Maps: []NamedMap{{Path: "/", Lines: []Line{{ID: "l1", X2: 1, Y2: 1}, {ID: "l1", X2: 2, Y2: 2}}}}},
			want: "collides with",
		},
		{
			name: "line invalid palette",
			g:    Graph{Maps: []NamedMap{{Path: "/", Lines: []Line{{ID: "l1", X2: 1, Y2: 1, Palette: 1}}}}},
			want: "invalid palette",
		},
		{
			name: "empty stroke id",
			g:    Graph{Maps: []NamedMap{{Path: "/", Strokes: []Stroke{{ID: "", Points: [][]float64{{0, 0}, {1, 1}}}}}}},
			want: "empty id",
		},
		{
			name: "duplicate stroke id",
			g: Graph{Maps: []NamedMap{{Path: "/", Strokes: []Stroke{
				{ID: "s1", Points: [][]float64{{0, 0}, {1, 1}}},
				{ID: "s1", Points: [][]float64{{0, 0}, {1, 1}}},
			}}}},
			want: "collides with",
		},
		{
			name: "stroke with too few points",
			g:    Graph{Maps: []NamedMap{{Path: "/", Strokes: []Stroke{{ID: "s1", Points: [][]float64{{0, 0}}}}}}},
			want: "need at least 2",
		},
		{
			name: "stroke point with wrong coord count",
			g:    Graph{Maps: []NamedMap{{Path: "/", Strokes: []Stroke{{ID: "s1", Points: [][]float64{{0, 0, 0}, {1, 1}}}}}}},
			want: "need 2",
		},
		{
			name: "stroke invalid palette",
			g:    Graph{Maps: []NamedMap{{Path: "/", Strokes: []Stroke{{ID: "s1", Points: [][]float64{{0, 0}, {1, 1}}, Palette: 1}}}}},
			want: "invalid palette",
		},
		{
			name: "empty image id",
			g:    Graph{Maps: []NamedMap{{Path: "/", Images: []Image{{ID: "", Src: "a.png", Width: 10, Height: 10}}}}},
			want: "empty id",
		},
		{
			name: "duplicate image id",
			g: Graph{Maps: []NamedMap{{Path: "/", Images: []Image{
				{ID: "i1", Src: "a.png", Width: 10, Height: 10},
				{ID: "i1", Src: "b.png", Width: 10, Height: 10},
			}}}},
			want: "collides with",
		},
		{
			name: "image with empty src",
			g:    Graph{Maps: []NamedMap{{Path: "/", Images: []Image{{ID: "i1", Src: "", Width: 10, Height: 10}}}}},
			want: "empty src",
		},
		{
			name: "image with non-positive size",
			g:    Graph{Maps: []NamedMap{{Path: "/", Images: []Image{{ID: "i1", Src: "a.png", Width: 0, Height: 10}}}}},
			want: "non-positive size",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			errs := Validate(tc.g)
			if len(errs) == 0 {
				t.Fatalf("Validate() returned no errors, want one containing %q", tc.want)
			}
			found := false
			for _, e := range errs {
				if strings.Contains(e.Error(), tc.want) {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("Validate() errors = %v, want one containing %q", errs, tc.want)
			}
		})
	}
}

// TestValidate_ValidNestedSubmapChain is the positive counterpart to
// the orphaned-submap cases above: a properly chained "/A/B" submap,
// where box A lives on "/" and box B lives on "/A", must validate
// clean.
// TestValidate_KnownShapeIDsAccepted keeps the shape gate honest in the
// other direction: every id the GUI can actually render (0 rectangle,
// 1 hexagon, 2 circle, 3 triangle) must pass, as box field and as the
// document default alike.
func TestValidate_KnownShapeIDsAccepted(t *testing.T) {
	for n := 0; n <= 3; n++ {
		g := Graph{DefaultShape: n, Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Shape: n}}}}}
		if errs := Validate(g); len(errs) != 0 {
			t.Errorf("shape %d rejected: %v", n, errs)
		}
	}
}

func TestValidate_ValidNestedSubmapChain(t *testing.T) {
	g := Graph{Maps: []NamedMap{
		{Path: "/", Boxes: []Box{{ID: "A"}}},
		{Path: "/A", Boxes: []Box{{ID: "B"}}},
		{Path: "/A/B", Boxes: []Box{{ID: "C"}}},
	}}
	if errs := Validate(g); len(errs) != 0 {
		t.Fatalf("Validate() = %v, want no errors for a properly chained submap", errs)
	}
}

func TestValidate_ValidHandlesAllAccepted(t *testing.T) {
	for _, h := range []string{"t", "r", "b", "l", "tl", "tr", "bl", "br"} {
		g := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "a"}, {ID: "b"}}, Edges: []Edge{{From: "a", To: "b", FromHandle: h, ToHandle: h}}}}}
		if errs := Validate(g); len(errs) != 0 {
			t.Errorf("Validate() with handle %q = %v, want no errors", h, errs)
		}
	}
}

// TestMapFlowgoIsValid parses the checked-in map.flowgo, validates it
// against our semantic rules, and round-trips it through the serializer
// to ensure parse/serialize/parse is idempotent.
func TestMapFlowgoIsValid(t *testing.T) {
	raw, err := os.ReadFile("map.flowgo")
	if err != nil {
		t.Fatalf("read map.flowgo: %v", err)
	}

	g, err := Parse(string(raw))
	if err != nil {
		t.Fatalf("parse map.flowgo: %v", err)
	}

	if errs := Validate(g); len(errs) > 0 {
		var b strings.Builder
		for _, e := range errs {
			b.WriteString("  - ")
			b.WriteString(e.Error())
			b.WriteString("\n")
		}
		t.Fatalf("map.flowgo failed validation (%d issue(s)):\n%s", len(errs), b.String())
	}

	round, err := Parse(Serialize(g))
	if err != nil {
		t.Fatalf("re-parse after serialize: %v", err)
	}
	if errs := Validate(round); len(errs) > 0 {
		t.Fatalf("round-tripped graph failed validation: %v", errs)
	}
	if !graphsEquivalent(g, round) {
		t.Fatalf("parse(serialize(g)) != g — lossy round-trip\noriginal: %s\nround-trip: %s",
			Serialize(g), Serialize(round))
	}
}

// graphsEquivalent compares two graphs ignoring the order of empty slices
// vs nil; the serializer drops empty maps, so the round-tripped graph may
// have fewer entries than the input if any map was empty to begin with.
func graphsEquivalent(a, b Graph) bool {
	keep := func(maps []NamedMap) []NamedMap {
		out := make([]NamedMap, 0, len(maps))
		for _, m := range maps {
			if len(m.Boxes) == 0 && len(m.Edges) == 0 && len(m.Texts) == 0 && len(m.Lines) == 0 && len(m.Strokes) == 0 {
				continue
			}
			out = append(out, m)
		}
		return out
	}
	ma, mb := keep(a.Maps), keep(b.Maps)
	if len(ma) != len(mb) {
		return false
	}
	for i := range ma {
		if !mapsEquivalent(ma[i], mb[i]) {
			return false
		}
	}
	return true
}

func mapsEquivalent(a, b NamedMap) bool {
	if a.Path != b.Path {
		return false
	}
	if len(a.Boxes) != len(b.Boxes) || len(a.Edges) != len(b.Edges) ||
		len(a.Texts) != len(b.Texts) || len(a.Lines) != len(b.Lines) ||
		len(a.Strokes) != len(b.Strokes) {
		return false
	}
	for i := range a.Boxes {
		if a.Boxes[i] != b.Boxes[i] {
			return false
		}
	}
	for i := range a.Edges {
		if a.Edges[i] != b.Edges[i] {
			return false
		}
	}
	for i := range a.Texts {
		if a.Texts[i] != b.Texts[i] {
			return false
		}
	}
	for i := range a.Lines {
		la, lb := a.Lines[i], b.Lines[i]
		if la.ID != lb.ID || la.X1 != lb.X1 || la.Y1 != lb.Y1 ||
			la.X2 != lb.X2 || la.Y2 != lb.Y2 || la.Palette != lb.Palette {
			return false
		}
		if len(la.Mids) != len(lb.Mids) {
			return false
		}
		for j := range la.Mids {
			if len(la.Mids[j]) != len(lb.Mids[j]) {
				return false
			}
			for k := range la.Mids[j] {
				if la.Mids[j][k] != lb.Mids[j][k] {
					return false
				}
			}
		}
	}
	for i := range a.Strokes {
		if a.Strokes[i].ID != b.Strokes[i].ID {
			return false
		}
		if a.Strokes[i].Palette != b.Strokes[i].Palette {
			return false
		}
		if len(a.Strokes[i].Points) != len(b.Strokes[i].Points) {
			return false
		}
		for j := range a.Strokes[i].Points {
			if len(a.Strokes[i].Points[j]) != len(b.Strokes[i].Points[j]) {
				return false
			}
			for k := range a.Strokes[i].Points[j] {
				if a.Strokes[i].Points[j][k] != b.Strokes[i].Points[j][k] {
					return false
				}
			}
		}
	}
	return true
}

// TestLabelCapCountsCodepointsNotBytes pins the label cap to a single
// definition. validateMap used to count with `len(label)` — Go's
// string length in BYTES — while NormalizeLabel (label.go) already
// capped by `[]rune` (Unicode codepoints), and the TS editor caps by
// UTF-16 code units (src/graph/label.ts). Three different counts for
// one constant meant a label NormalizeLabel had already capped to
// exactly MaxLabelLen runes could still fail Validate, because
// multi-byte runes (any non-ASCII character) make the byte count
// larger than the rune count for the same string.
func TestLabelCapCountsCodepointsNotBytes(t *testing.T) {
	// 500 codepoints, each 3 bytes in UTF-8 (1500 bytes total): well
	// past MaxLabelLen if counted in bytes, exactly at the cap if
	// counted in codepoints (runes) — which is what NormalizeLabel
	// guarantees callers already produced.
	label := strings.Repeat("日", MaxLabelLen)
	if n := len([]rune(label)); n != MaxLabelLen {
		t.Fatalf("test setup: label has %d runes, want %d", n, MaxLabelLen)
	}
	if n := len(label); n <= MaxLabelLen {
		t.Fatalf("test setup: label is only %d bytes, need > %d to exercise the bug", n, MaxLabelLen)
	}

	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "b1", Label: label}, {ID: "b2", Label: "x"}},
		Texts: []Text{{ID: "t1", Label: label}},
		Edges: []Edge{{From: "b1", To: "b2", Label: label}},
	}}}
	if errs := Validate(g); len(errs) > 0 {
		t.Errorf("a label at exactly MaxLabelLen codepoints was rejected: %v", errs)
	}

	// One codepoint over the cap must still be rejected.
	over := label + "本"
	gOver := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: over}}}}}
	errs := Validate(gOver)
	if !containsSubstring(errs, "cap is") {
		t.Errorf("a label one codepoint over the cap was not rejected: %v", errs)
	}
}
