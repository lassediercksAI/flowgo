package flowgo

import (
	"strings"
	"testing"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// w/h on add_box / update_box (the resize feature's MCP surface).
// Contract under test: both-or-neither, clamped to the editor's
// minimums, and w=0 h=0 restores auto-size on update.

func TestActAddBox_AcceptsSize(t *testing.T) {
	g := freshGraph()
	id, err := actAddBox(g, map[string]any{
		"label": "sized",
		"x":     float64(0),
		"y":     float64(0),
		"w":     float64(200),
		"h":     float64(120),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	rawID := mcpFirstText(id)
	var got *graph.Box
	for i := range g.Maps[0].Boxes {
		if g.Maps[0].Boxes[i].ID == rawID {
			got = &g.Maps[0].Boxes[i]
		}
	}
	if got == nil {
		t.Fatalf("box %s not found after add", rawID)
	}
	if got.W != 200 || got.H != 120 {
		t.Fatalf("size not applied: W=%g H=%g", got.W, got.H)
	}
}

func TestActAddBox_SizeClampedToMin(t *testing.T) {
	g := freshGraph()
	id, err := actAddBox(g, map[string]any{
		"label": "tiny",
		"x":     float64(0),
		"y":     float64(0),
		"w":     float64(10),
		"h":     float64(5),
	})
	if err != nil {
		t.Fatalf("actAddBox: %v", err)
	}
	rawID := mcpFirstText(id)
	for _, b := range g.Maps[0].Boxes {
		if b.ID == rawID {
			if b.W != minBoxW || b.H != minBoxH {
				t.Fatalf("clamp failed: W=%g H=%g want %dx%d", b.W, b.H, minBoxW, minBoxH)
			}
			return
		}
	}
	t.Fatalf("box %s not found", rawID)
}

func TestActAddBox_RejectsOneSidedSize(t *testing.T) {
	g := freshGraph()
	_, err := actAddBox(g, map[string]any{
		"label": "half",
		"x":     float64(0),
		"y":     float64(0),
		"w":     float64(200),
	})
	if err == nil || !strings.Contains(err.Error(), "together") {
		t.Fatalf("expected both-or-neither error, got %v", err)
	}
}

func TestActUpdateBox_SetAndClearSize(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "b1", Label: "x"}}

	if _, err := actUpdateBox(g, map[string]any{
		"id": "b1", "w": float64(150), "h": float64(90),
	}); err != nil {
		t.Fatalf("set size: %v", err)
	}
	if b := g.Maps[0].Boxes[0]; b.W != 150 || b.H != 90 {
		t.Fatalf("size not set: W=%g H=%g", b.W, b.H)
	}

	// w=0 h=0 → back to auto-size.
	if _, err := actUpdateBox(g, map[string]any{
		"id": "b1", "w": float64(0), "h": float64(0),
	}); err != nil {
		t.Fatalf("clear size: %v", err)
	}
	if b := g.Maps[0].Boxes[0]; b.W != 0 || b.H != 0 {
		t.Fatalf("auto-size not restored: W=%g H=%g", b.W, b.H)
	}
}

func TestActAddBox_RejectsSizeOnHexagon(t *testing.T) {
	g := freshGraph()
	_, err := actAddBox(g, map[string]any{
		"label": "hex",
		"x":     float64(0),
		"y":     float64(0),
		"shape": float64(1),
		"w":     float64(200),
		"h":     float64(120),
	})
	if err == nil || !strings.Contains(err.Error(), "not resizable") {
		t.Fatalf("expected not-resizable error, got %v", err)
	}
}

func TestActUpdateBox_RejectsSizeOnHexagon(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "b1", Label: "hex", Shape: 1}}
	_, err := actUpdateBox(g, map[string]any{
		"id": "b1", "w": float64(200), "h": float64(120),
	})
	if err == nil || !strings.Contains(err.Error(), "not resizable") {
		t.Fatalf("expected not-resizable error for existing hex, got %v", err)
	}
}

func TestActUpdateBox_BecomingHexClearsPinnedSize(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "b1", Label: "x", W: 150, H: 90}}
	if _, err := actUpdateBox(g, map[string]any{
		"id": "b1", "shape": float64(1),
	}); err != nil {
		t.Fatalf("shape change: %v", err)
	}
	if b := g.Maps[0].Boxes[0]; b.Shape != 1 || b.W != 0 || b.H != 0 {
		t.Fatalf("becoming hex should clear size: %+v", b)
	}
}

func TestActUpdateBox_RejectsNegativeSize(t *testing.T) {
	g := freshGraph()
	g.Maps[0].Boxes = []graph.Box{{ID: "b1", Label: "x"}}
	_, err := actUpdateBox(g, map[string]any{
		"id": "b1", "w": float64(-5), "h": float64(90),
	})
	if err == nil || !strings.Contains(err.Error(), "positive") {
		t.Fatalf("expected positive-dims error, got %v", err)
	}
}
