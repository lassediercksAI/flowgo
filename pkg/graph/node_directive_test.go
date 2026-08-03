package graph

import (
	"reflect"
	"strings"
	"testing"
)

// `node` / `nodesize` / `nodeshape` are the canonical directives;
// `box` / `boxsize` / `boxshape` are deprecated legacy spellings kept
// as parse-only aliases (until at least v0.5.x). These tests pin the
// alias contract: identical parse results, node-form emission (the
// migration), and mixed-form files staying readable.

const legacyDoc = `version v0.2.0
box b1 "Sized One" 10 20 4 3
box b2 Hex 30 40
boxsize b1 180.5 90
boxshape b2 1
anchor b2
`

const nodeDoc = `version v0.2.0
node b1 "Sized One" 10 20 4 3
node b2 Hex 30 40
nodesize b1 180.5 90
nodeshape b2 1
anchor b2
`

func TestLegacyBoxDirectivesParseIdenticallyToNode(t *testing.T) {
	legacy, err := Parse(legacyDoc)
	if err != nil {
		t.Fatalf("parse legacy: %v", err)
	}
	canonical, err := Parse(nodeDoc)
	if err != nil {
		t.Fatalf("parse node: %v", err)
	}
	if !reflect.DeepEqual(legacy, canonical) {
		t.Fatalf("legacy and node forms parse differently:\nlegacy: %+v\nnode:   %+v", legacy, canonical)
	}
}

func TestLegacyBoxFileMigratesToNodeFormsOnSerialize(t *testing.T) {
	g, err := Parse(legacyDoc)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	out := Serialize(g)
	for _, want := range []string{"node b1 ", "node b2 ", "nodesize b1 180.5 90\n", "nodeshape b2 1\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("serialized output missing %q:\n%s", want, out)
		}
	}
	for _, stale := range []string{"\nbox ", "boxsize ", "boxshape "} {
		if strings.Contains(out, stale) || strings.HasPrefix(out, "box ") {
			t.Errorf("serialized output still contains legacy form %q:\n%s", stale, out)
		}
	}
	// The migrated bytes must themselves round-trip.
	back, err := Parse(out)
	if err != nil {
		t.Fatalf("re-parse migrated output: %v", err)
	}
	if again := Serialize(back); again != out {
		t.Fatalf("migrated output not byte-stable:\n--- first ---\n%s\n--- second ---\n%s", out, again)
	}
}

func TestMixedLegacyAndNodeDirectivesParse(t *testing.T) {
	// A half-migrated file: node and box forms interleaved, legacy
	// size/shape annotations pointing at canonical-form nodes and
	// vice versa.
	mixed := `node b1 First 0 0
box b2 Second 100 0
nodesize b2 120 60
boxshape b1 1
`
	g, err := Parse(mixed)
	if err != nil {
		t.Fatalf("parse mixed: %v", err)
	}
	boxes := g.Maps[0].Boxes
	if len(boxes) != 2 {
		t.Fatalf("want 2 nodes, got %d", len(boxes))
	}
	if boxes[0].Shape != 1 {
		t.Errorf("boxshape alias did not apply to node-form b1: %+v", boxes[0])
	}
	if boxes[1].W != 120 || boxes[1].H != 60 {
		t.Errorf("nodesize did not apply to box-form b2: %+v", boxes[1])
	}
}
