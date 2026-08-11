package flowgo

import (
	"testing"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// Hexagon lattice snapping on the MCP surface. Contract under test:
// the schema's promise that hexagons are "lattice-snapped, never
// overlap" is enforced on add_box, update_box (move and become-hex),
// and set_state — mirroring what the GUI does on create/drag/paste.

// hexAt builds a hexagon Box whose CENTRE is (cx, cy).
func hexAt(id string, cx, cy float64) graph.Box {
	return graph.Box{ID: id, Label: id, Shape: 1, X: cx - graph.HexW/2, Y: cy - graph.HexH/2}
}

func boxCenter(b graph.Box) graph.HexPoint {
	return graph.HexPoint{X: b.X + graph.HexW/2, Y: b.Y + graph.HexH/2}
}

func findBox(t *testing.T, g *Graph, id string) graph.Box {
	t.Helper()
	for _, b := range g.Maps[0].Boxes {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("box %s not found", id)
	return graph.Box{}
}

func TestActAddBox_HexSnapsOntoLattice(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{hexAt("h1", 500, 500)}
	// Propose a hex nearly on top of h1 — the GUI would push it to the
	// nearest free lattice cell; the MCP must do the same.
	res, err := actAddBox(g, map[string]any{
		"label": "h2",
		"x":     float64(500 + 10 - graph.HexW/2),
		"y":     float64(500 - 5 - graph.HexH/2),
		"shape": float64(1),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	added := findBox(t, g, mcpFirstText(res))
	if graph.HexesOverlap(boxCenter(added), graph.HexPoint{X: 500, Y: 500}) {
		t.Fatalf("added hex overlaps existing one: centre %+v", boxCenter(added))
	}
}

func TestActAddBox_HexFarAwayStaysPut(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{hexAt("h1", 0, 0)}
	x, y := float64(2000), float64(2000)
	res, err := actAddBox(g, map[string]any{
		"label": "lone", "x": x, "y": y, "shape": float64(1),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	added := findBox(t, g, mcpFirstText(res))
	if added.X != x || added.Y != y {
		t.Fatalf("out-of-range hex moved: (%g,%g)", added.X, added.Y)
	}
}

func TestActAddBox_RectangleNeverSnaps(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{hexAt("h1", 500, 500)}
	x, y := float64(500-graph.HexW/2), float64(500-graph.HexH/2)
	res, err := actAddBox(g, map[string]any{"label": "r", "x": x, "y": y})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	added := findBox(t, g, mcpFirstText(res))
	if added.X != x || added.Y != y {
		t.Fatalf("rectangle moved: (%g,%g)", added.X, added.Y)
	}
}

func TestActUpdateBox_MoveHexSnaps(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{hexAt("h1", 500, 500), hexAt("h2", 2000, 2000)}
	// Drag h2 onto h1 via MCP: it must land flush, not stacked.
	_, err := actUpdateBox(g, map[string]any{
		"id": "h2",
		"x":  float64(500 + 8 - graph.HexW/2),
		"y":  float64(500 + 8 - graph.HexH/2),
	})
	if err != nil {
		t.Fatalf("actUpdateBox: %v", err)
	}
	moved := findBox(t, g, "h2")
	if graph.HexesOverlap(boxCenter(moved), graph.HexPoint{X: 500, Y: 500}) {
		t.Fatalf("moved hex overlaps target: centre %+v", boxCenter(moved))
	}
}

func TestActUpdateBox_BecomeHexSnaps(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{
		hexAt("h1", 500, 500),
		{ID: "r1", Label: "r", X: 500 - graph.HexW/2, Y: 500 - graph.HexH/2},
	}
	_, err := actUpdateBox(g, map[string]any{"id": "r1", "shape": float64(1)})
	if err != nil {
		t.Fatalf("actUpdateBox: %v", err)
	}
	became := findBox(t, g, "r1")
	if graph.HexesOverlap(boxCenter(became), graph.HexPoint{X: 500, Y: 500}) {
		t.Fatalf("shape-changed hex overlaps existing one: centre %+v", boxCenter(became))
	}
}

func TestActSetState_SettlesStackedHexes(t *testing.T) {
	g := freshGraph()
	boxes := []map[string]any{}
	for i := 0; i < 5; i++ {
		boxes = append(boxes, map[string]any{
			"id": string(rune('a' + i)), "label": "h",
			"x": float64(20 * i), "y": float64(20 * i), "shape": float64(1),
		})
	}
	_, err := actSetState(g, map[string]any{
		"graph": map[string]any{
			"maps": []map[string]any{{"path": "/", "boxes": boxes}},
		},
	})
	if err != nil {
		t.Fatalf("actSetState: %v", err)
	}
	bs := g.Maps[0].Boxes
	for i := 0; i < len(bs); i++ {
		for j := i + 1; j < len(bs); j++ {
			if graph.HexesOverlap(boxCenter(bs[i]), boxCenter(bs[j])) {
				t.Fatalf("hexes %s and %s still overlap after set_state", bs[i].ID, bs[j].ID)
			}
		}
	}
}
