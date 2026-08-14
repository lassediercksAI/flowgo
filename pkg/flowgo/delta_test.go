package flowgo

import (
	"encoding/json"
	"strings"
	"testing"
)

// Unit tests for the delta op semantics (brain#25c). The end-to-end
// protocol — byte parity, revision guard, atomicity, gzip — is tested
// against the real HTTP handlers in cmd/flowgo/save_delta_test.go;
// here the individual op rules are pinned where a mutation would be
// easiest to miss.

func opGraph() Graph {
	return Graph{Maps: []NamedMap{
		{Path: "/", Boxes: []Box{{ID: "a", Label: "alpha"}, {ID: "b", Label: "beta"}}},
		{Path: "/a", Boxes: []Box{{ID: "a1", Label: "child"}}},
		{Path: "/a/x", Boxes: []Box{{ID: "ax1", Label: "grand"}}},
		{Path: "/ab", Boxes: []Box{{ID: "ab1", Label: "sibling"}}},
		{Path: "/abc", Boxes: []Box{{ID: "abc1", Label: "longer sibling"}}},
	}}
}

func mapPaths(g Graph) []string {
	out := make([]string, len(g.Maps))
	for i, m := range g.Maps {
		out[i] = m.Path
	}
	return out
}

// The "/" boundary rule, ported from the editor's withoutSubmaps
// (src/editor/factories.ts): a descendant of "/a" is a path starting
// with "/a/" — "/ab" and "/abc" merely share prefix BYTES and must
// survive. A bare prefix test is the classic wrong implementation.
func TestDropMapSubtreeBoundary(t *testing.T) {
	cases := []struct {
		drop string
		want string
	}{
		{drop: "/a", want: "/ /ab /abc"},
		{drop: "/ab", want: "/ /a /a/x /abc"},
		{drop: "/abc", want: "/ /a /a/x /ab"},
		{drop: "/nope", want: "/ /a /a/x /ab /abc"},
	}
	for _, c := range cases {
		g := opGraph()
		if err := applyDeltaOp(&g, DeltaOp{Op: "drop-map", Map: c.drop}); err != nil {
			t.Fatalf("drop-map %s: %v", c.drop, err)
		}
		if got := strings.Join(mapPaths(g), " "); got != c.want {
			t.Errorf("drop-map %s left %q, want %q", c.drop, got, c.want)
		}
	}
}

// Upsert of an existing id replaces IN PLACE — appending a duplicate
// would serialize two directives for one id and break byte parity
// with the equivalent full save.
func TestUpsertReplacesInPlaceNotAppend(t *testing.T) {
	g := opGraph()
	op := DeltaOp{Op: "upsert", Kind: "box", Map: "/",
		Item: json.RawMessage(`{"id":"a","label":"alpha2","x":9}`)}
	if err := applyDeltaOp(&g, op); err != nil {
		t.Fatal(err)
	}
	boxes := g.Maps[0].Boxes
	if len(boxes) != 2 {
		t.Fatalf("upsert of existing id changed the count: %d boxes", len(boxes))
	}
	if boxes[0].ID != "a" || boxes[0].Label != "alpha2" || boxes[0].X != 9 {
		t.Errorf("existing element not replaced in position 0: %+v", boxes[0])
	}
}

func TestUpsertUnknownIDAppends(t *testing.T) {
	g := opGraph()
	op := DeltaOp{Op: "upsert", Kind: "box", Map: "/",
		Item: json.RawMessage(`{"id":"c","label":"gamma"}`)}
	if err := applyDeltaOp(&g, op); err != nil {
		t.Fatal(err)
	}
	boxes := g.Maps[0].Boxes
	if len(boxes) != 3 || boxes[2].ID != "c" {
		t.Errorf("new element must append at the end: %+v", boxes)
	}
}

// Deletes tolerate absence (LWW): a missing id and a missing map are
// both no-ops, never errors — the second client to delete the same
// thing must not fail.
func TestDeleteMissingIsNoOp(t *testing.T) {
	g := opGraph()
	for _, op := range []DeltaOp{
		{Op: "delete", Kind: "box", Map: "/", ID: "never-existed"},
		{Op: "delete", Kind: "stroke", Map: "/", ID: "a"}, // right id, wrong kind's collection
		{Op: "delete", Kind: "box", Map: "/gone", ID: "a"},
	} {
		if err := applyDeltaOp(&g, op); err != nil {
			t.Errorf("delete %+v must be a no-op, got error: %v", op, err)
		}
	}
	if len(g.Maps[0].Boxes) != 2 || len(g.Maps) != 5 {
		t.Errorf("no-op deletes changed the graph: %+v", g)
	}
}

// An unknown kind is a 400-class error even when the op would
// otherwise be a no-op — a confused client should hear about it.
func TestUnknownKindRejectedEvenOnMissingMap(t *testing.T) {
	g := opGraph()
	err := applyDeltaOp(&g, DeltaOp{Op: "delete", Kind: "kine", Map: "/gone", ID: "x"})
	if err == nil || !strings.Contains(err.Error(), "kine") {
		t.Errorf("unknown kind on a missing map must still error by name, got %v", err)
	}
}
