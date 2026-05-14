package main

import (
	"os"
	"strings"
	"testing"
)

// TestMapFlowgoIsValid parses the checked-in map.flowgo, validates it
// against our semantic rules, and round-trips it through the serializer
// to ensure parse/serialize/parse is idempotent.
func TestMapFlowgoIsValid(t *testing.T) {
	raw, err := os.ReadFile("map.flowgo")
	if err != nil {
		t.Fatalf("read map.flowgo: %v", err)
	}

	g, err := parse(string(raw))
	if err != nil {
		t.Fatalf("parse map.flowgo: %v", err)
	}

	if errs := validateGraph(g); len(errs) > 0 {
		var b strings.Builder
		for _, e := range errs {
			b.WriteString("  - ")
			b.WriteString(e.Error())
			b.WriteString("\n")
		}
		t.Fatalf("map.flowgo failed validation (%d issue(s)):\n%s", len(errs), b.String())
	}

	// parse → serialize → parse must yield an equivalent graph; otherwise
	// we have a lossy round-trip somewhere (e.g., a new field that the
	// serializer forgot to emit, or the parser dropped on the way in).
	round, err := parse(serialize(g))
	if err != nil {
		t.Fatalf("re-parse after serialize: %v", err)
	}
	if errs := validateGraph(round); len(errs) > 0 {
		t.Fatalf("round-tripped graph failed validation: %v", errs)
	}
	if !graphsEquivalent(g, round) {
		t.Fatalf("parse(serialize(g)) != g — lossy round-trip\noriginal: %s\nround-trip: %s",
			serialize(g), serialize(round))
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
		if a.Lines[i] != b.Lines[i] {
			return false
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
