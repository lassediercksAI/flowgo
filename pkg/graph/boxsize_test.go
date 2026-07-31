package graph

import (
	"encoding/json"
	"strings"
	"testing"
)

// The boxsize directive gives a box an explicit on-canvas size (the
// resize feature). These tests pin the parse/serialize round-trip and
// the failure modes so the TS serializer mirror in src/graph can be
// checked against the same fixtures.

func TestParseBoxsize(t *testing.T) {
	g, err := Parse("box b1 hello 10 20\nboxsize b1 200 120\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	b := g.Maps[0].Boxes[0]
	if b.W != 200 || b.H != 120 {
		t.Fatalf("got W=%g H=%g, want 200x120", b.W, b.H)
	}
}

func TestParseBoxsizeUnknownBox(t *testing.T) {
	_, err := Parse("box b1 hello 10 20\nboxsize nope 200 120\n")
	if err == nil || !strings.Contains(err.Error(), "unknown box") {
		t.Fatalf("expected unknown-box error, got %v", err)
	}
}

func TestParseBoxsizeNonPositiveIgnored(t *testing.T) {
	// Zero / negative dims mean auto-size; the directive is skipped
	// rather than erroring so hand-edited files degrade gracefully.
	g, err := Parse("box b1 hello 10 20\nboxsize b1 0 120\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	b := g.Maps[0].Boxes[0]
	if b.W != 0 || b.H != 0 {
		t.Fatalf("non-positive boxsize should leave auto-size, got W=%g H=%g", b.W, b.H)
	}
}

func TestSerializeBoxsizeRoundTrip(t *testing.T) {
	in := Graph{Maps: []NamedMap{{
		Path: "/",
		Boxes: []Box{
			{ID: "b1", Label: "sized", X: 1, Y: 2, W: 180.5, H: 90},
			{ID: "b2", Label: "auto", X: 3, Y: 4},
		},
	}}}
	out := Serialize(in)
	if !strings.Contains(out, "boxsize b1 180.5 90\n") {
		t.Fatalf("serialized output missing boxsize line:\n%s", out)
	}
	if strings.Contains(out, "boxsize b2") {
		t.Fatalf("auto-sized box must not emit boxsize:\n%s", out)
	}
	back, err := Parse(out)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	rb := back.Maps[0].Boxes[0]
	if rb.W != 180.5 || rb.H != 90 {
		t.Fatalf("round-trip lost size: W=%g H=%g", rb.W, rb.H)
	}
	// Second serialize must be byte-stable.
	if again := Serialize(back); again != out {
		t.Fatalf("serialize not stable:\n--- first ---\n%s\n--- second ---\n%s", out, again)
	}
}

func TestBoxsizeJSONWireFormat(t *testing.T) {
	// The editor consumes boxes as JSON over /state — w/h must use the
	// short keys and omit when zero (auto-size).
	sized, _ := json.Marshal(Box{ID: "a", Label: "l", W: 100, H: 50})
	if !strings.Contains(string(sized), `"w":100`) || !strings.Contains(string(sized), `"h":50`) {
		t.Fatalf("sized box JSON missing w/h: %s", sized)
	}
	auto, _ := json.Marshal(Box{ID: "a", Label: "l"})
	if strings.Contains(string(auto), `"w"`) || strings.Contains(string(auto), `"h"`) {
		t.Fatalf("auto box JSON must omit w/h: %s", auto)
	}
}
