package flowgo

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// SaveLocalGraph takes a whole document straight from the editor's
// /save POST, which is unauthenticated on the bind address. Until it
// validated, a single crafted field wrote bytes graph.Parse then
// rejected — and since the .flowgo file IS the document, that was
// permanent: /state, every MCP tool, and the next `flowgo` invocation
// all fail at the parse step with no way back but a text editor.
//
// These tests go through the real read path (LocalGraph, which stats
// the file and re-parses) rather than re-parsing bytes directly, so a
// rejected save that nonetheless poisoned the in-memory cache would
// still show up.

func craftedSaves() []struct {
	name string
	g    graph.Graph
} {
	return []struct {
		name string
		g    graph.Graph
	}{
		{
			// brain#245 repro step 2, verbatim.
			name: "id forges a second node directive",
			g: graph.Graph{Maps: []graph.NamedMap{{Path: "/", Boxes: []graph.Box{
				{ID: "b1 0 0\npwned", Label: "x"},
			}}}},
		},
		{
			// brain#245 repro step 4.
			name: "label carries a carriage return",
			g: graph.Graph{Maps: []graph.NamedMap{{Path: "/", Boxes: []graph.Box{
				{ID: "b1", Label: "a\rb"},
			}}}},
		},
		{
			name: "id contains a double quote",
			g: graph.Graph{Maps: []graph.NamedMap{{Path: "/", Boxes: []graph.Box{
				{ID: `b"1`, Label: "x"},
			}}}},
		},
		{
			name: "id contains a backslash",
			g: graph.Graph{Maps: []graph.NamedMap{{Path: "/", Boxes: []graph.Box{
				{ID: `b\1`, Label: "x"},
			}}}},
		},
		{
			name: "id collides with the edge handle separator",
			g: graph.Graph{Maps: []graph.NamedMap{{Path: "/", Boxes: []graph.Box{
				{ID: "b1:t", Label: "x"}, {ID: "b2", Label: "y"},
			}, Edges: []graph.Edge{{From: "b1:t", To: "b2"}}}}},
		},
		{
			name: "map path forges a directive",
			g: graph.Graph{Maps: []graph.NamedMap{
				{Path: "/", Boxes: []graph.Box{{ID: "a", Label: "A"}}},
				{Path: "/a\nnode evil x 0 0", Boxes: []graph.Box{{ID: "b1", Label: "x"}}},
			}},
		},
		{
			name: "text id is empty",
			g: graph.Graph{Maps: []graph.NamedMap{{Path: "/", Texts: []graph.Text{
				{Label: "x"},
			}}}},
		},
	}
}

const goodDoc = "version 0.0.1\nnode b1 hello 0 0\nnode b2 \"two words\" 100 0\n\nedge b1 b2\n"

func TestSaveLocalGraphRejectsCraftedFieldsAndLeavesFileReadable(t *testing.T) {
	for _, tc := range craftedSaves() {
		t.Run(tc.name, func(t *testing.T) {
			path := configureLocalFile(t, goodDoc)

			// Warm the cache through the real read path first, the way a
			// running server would have.
			if _, err := LocalGraph(); err != nil {
				t.Fatalf("initial LocalGraph: %v", err)
			}

			err := SaveLocalGraph(tc.g)
			if err == nil {
				t.Fatalf("crafted save accepted; file is now %q", mustRead(t, path))
			}
			if !errors.Is(err, ErrInvalidGraph) {
				t.Errorf("error does not wrap ErrInvalidGraph: %v", err)
			}

			// The document on disk must be exactly what it was.
			if got := mustRead(t, path); got != goodDoc {
				t.Errorf("rejected save touched the file:\n got:  %q\n want: %q", got, goodDoc)
			}

			// And the real read path must still work — a rejected save
			// may not leave a poisoned cache behind either.
			g, err := LocalGraph()
			if err != nil {
				t.Fatalf("LocalGraph after rejected save: %v", err)
			}
			if len(g.Maps) != 1 || len(g.Maps[0].Boxes) != 2 {
				t.Errorf("document changed: %+v", g.Maps)
			}
		})
	}
}

// TestSaveLocalGraphStillAcceptsEveryRealFixture is the compatibility
// side of the gate. The new check runs on every editor save, so a
// checked-in document it refuses would be a document users can open
// but never write back.
func TestSaveLocalGraphStillAcceptsEveryRealFixture(t *testing.T) {
	for name, content := range realFixtures(t) {
		t.Run(name, func(t *testing.T) {
			g, err := graph.Parse(content)
			if err != nil {
				t.Fatalf("fixture does not parse: %v", err)
			}
			path := configureLocalFile(t, content)
			if err := SaveLocalGraph(g); err != nil {
				t.Fatalf("real fixture refused by the new write gate: %v", err)
			}
			stamped := g
			stamped.Version = "dev"
			if got, want := mustRead(t, path), graph.Serialize(stamped); got != want {
				t.Errorf("bytes changed:\n got:  %q\n want: %q", got, want)
			}
			// Reopening through the real read path must agree.
			back, err := LocalGraph()
			if err != nil {
				t.Fatalf("LocalGraph: %v", err)
			}
			if len(back.Maps) != len(g.Maps) {
				t.Errorf("map count changed: %d -> %d", len(g.Maps), len(back.Maps))
			}
		})
	}
}

// TestSaveLocalGraphAcceptsEmptyLabels: clearing a node's text is an
// ordinary edit, and it used to be enough to lose the file (the empty
// quoted label tokenized away, leaving a line the parser rejected).
// The save must go through AND the result must reopen.
func TestSaveLocalGraphAcceptsEmptyLabels(t *testing.T) {
	path := configureLocalFile(t, goodDoc)
	g := graph.Graph{Maps: []graph.NamedMap{{Path: "/", Boxes: []graph.Box{
		{ID: "b1", Label: ""},
		{ID: "b2", Label: "kept"},
	}}}}
	if err := SaveLocalGraph(g); err != nil {
		t.Fatalf("SaveLocalGraph: %v", err)
	}
	back, err := LocalGraph()
	if err != nil {
		t.Fatalf("LocalGraph after saving an empty label: %v\nfile: %q", err, mustRead(t, path))
	}
	if len(back.Maps[0].Boxes) != 2 || back.Maps[0].Boxes[0].Label != "" {
		t.Errorf("boxes = %+v", back.Maps[0].Boxes)
	}
}

// TestSaveLocalGraphKeepsAcceptingMidEditDocuments is why the save
// gate is ValidateWritable and not the full Validate: the editor can
// legitimately hold a document that fails semantic validation between
// two user actions, and refusing to persist it would be a worse bug
// than the one being fixed.
func TestSaveLocalGraphKeepsAcceptingMidEditDocuments(t *testing.T) {
	configureLocalFile(t, goodDoc)
	cases := map[string]graph.Graph{
		"edge pointing at a just-deleted node": {Maps: []graph.NamedMap{{
			Path:  "/",
			Boxes: []graph.Box{{ID: "b1", Label: "one"}},
			Edges: []graph.Edge{{From: "b1", To: "b2"}},
		}}},
		"submap outliving its node": {Maps: []graph.NamedMap{
			{Path: "/", Boxes: []graph.Box{{ID: "b1", Label: "one"}}},
			{Path: "/gone", Boxes: []graph.Box{{ID: "b9", Label: "orphan"}}},
		}},
		"out-of-range palette": {Maps: []graph.NamedMap{{
			Path:  "/",
			Boxes: []graph.Box{{ID: "b1", Label: "one", Palette: 42}},
		}}},
	}
	for name, g := range cases {
		t.Run(name, func(t *testing.T) {
			if err := SaveLocalGraph(g); err != nil {
				t.Fatalf("save refused a document the editor can hold: %v", err)
			}
			if _, err := LocalGraph(); err != nil {
				t.Fatalf("LocalGraph: %v", err)
			}
		})
	}
}

func TestErrInvalidGraphNamesTheOffendingField(t *testing.T) {
	configureLocalFile(t, goodDoc)
	err := SaveLocalGraph(graph.Graph{Maps: []graph.NamedMap{{Path: "/", Boxes: []graph.Box{
		{ID: "b1 0 0\npwned", Label: "x"},
	}}}})
	if err == nil {
		t.Fatal("accepted")
	}
	if !strings.Contains(err.Error(), "b1 0 0") || !strings.Contains(err.Error(), "line break") {
		t.Errorf("error should name the field and the reason, got: %v", err)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}
