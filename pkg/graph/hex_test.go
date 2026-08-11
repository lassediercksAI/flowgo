// Go mirror of the key cases in src/graph/hex.test.ts — the two
// implementations must agree cell-for-cell, so these tests pin the
// same behaviours the TS suite pins.
package graph

import (
	"math"
	"testing"
)

func TestHexConstants(t *testing.T) {
	// The never-overlap invariant: outside the magnetic range every
	// other centre is further away than a full hex width.
	if HexSnapRadius <= HexW {
		t.Fatalf("HexSnapRadius (%v) must exceed HexW (%v)", HexSnapRadius, HexW)
	}
	if HexCol != HexW*0.75 || HexRow != HexH {
		t.Fatalf("lattice steps must derive from the fixed size")
	}
}

func TestAxialRoundTrip(t *testing.T) {
	origin := HexPoint{X: 1000.25, Y: -37.5} // deliberately off-grid
	for q := -3; q <= 3; q++ {
		for r := -3; r <= 3; r++ {
			c := AxialToWorld(origin, Axial{Q: q, R: r})
			fq, fr := WorldToAxial(origin, c)
			if math.Abs(fq-float64(q)) > 1e-9 || math.Abs(fr-float64(r)) > 1e-9 {
				t.Fatalf("round-trip drift at (%d,%d): got (%v,%v)", q, r, fq, fr)
			}
			if got := AxialRound(fq, fr); got != (Axial{Q: q, R: r}) {
				t.Fatalf("AxialRound(%v,%v) = %+v, want (%d,%d)", fq, fr, got, q, r)
			}
		}
	}
}

func TestNearestCellCubeRounding(t *testing.T) {
	origin := HexPoint{}
	a := AxialToWorld(origin, Axial{Q: 0, R: 0})
	b := AxialToWorld(origin, Axial{Q: 1, R: 0})
	nearA := HexPoint{X: a.X + (b.X-a.X)*0.45, Y: a.Y + (b.Y-a.Y)*0.45}
	nearB := HexPoint{X: a.X + (b.X-a.X)*0.55, Y: a.Y + (b.Y-a.Y)*0.55}
	if got := NearestCell(origin, nearA); got != (Axial{Q: 0, R: 0}) {
		t.Fatalf("nearA rounded to %+v", got)
	}
	if got := NearestCell(origin, nearB); got != (Axial{Q: 1, R: 0}) {
		t.Fatalf("nearB rounded to %+v", got)
	}
}

func TestHexesOverlap(t *testing.T) {
	o := HexPoint{X: 500, Y: 500}
	// Exact lattice adjacency is touching, not overlapping.
	for _, cell := range []Axial{{Q: 1, R: 0}, {Q: 0, R: 1}, {Q: 1, R: -1}, {Q: -1, R: 1}} {
		if HexesOverlap(o, AxialToWorld(o, cell)) {
			t.Fatalf("adjacent cell %+v flagged as overlap", cell)
		}
	}
	// Real intrusions.
	for _, p := range []HexPoint{o, {X: o.X, Y: o.Y + HexH - 2}, {X: o.X + HexW - 10, Y: o.Y}} {
		if !HexesOverlap(o, p) {
			t.Fatalf("intrusion %+v not flagged", p)
		}
	}
	// Genuinely separated.
	for _, p := range []HexPoint{{X: o.X, Y: o.Y + HexH + 1}, {X: o.X + HexW + 1, Y: o.Y}} {
		if HexesOverlap(o, p) {
			t.Fatalf("separated %+v flagged as overlap", p)
		}
	}
}

func TestSnapHexCenter(t *testing.T) {
	anchor := HexPoint{X: 300.5, Y: 200.5} // off-grid cluster anchor

	if _, ok := SnapHexCenter(HexPoint{X: 10, Y: 10}, nil); ok {
		t.Fatalf("no other hexes must mean free placement")
	}
	far := HexPoint{X: anchor.X + HexSnapRadius + 50, Y: anchor.Y}
	if _, ok := SnapHexCenter(far, []HexPoint{anchor}); ok {
		t.Fatalf("outside magnetic range must not snap")
	}

	// A proposal near the +q neighbour lands exactly on that cell.
	want := AxialToWorld(anchor, Axial{Q: 1, R: 0})
	got, ok := SnapHexCenter(HexPoint{X: want.X + 15, Y: want.Y - 10}, []HexPoint{anchor})
	if !ok || math.Abs(got.X-want.X) > 1e-9 || math.Abs(got.Y-want.Y) > 1e-9 {
		t.Fatalf("snap = %+v (ok=%v), want %+v", got, ok, want)
	}

	// A proposal on top of the anchor is pushed to a FREE cell, never
	// stacked: the result must not overlap the anchor.
	got, ok = SnapHexCenter(HexPoint{X: anchor.X + 5, Y: anchor.Y - 3}, []HexPoint{anchor})
	if !ok {
		t.Fatalf("in-range proposal must snap")
	}
	if HexesOverlap(got, anchor) {
		t.Fatalf("snapped hex %+v overlaps its anchor %+v", got, anchor)
	}
}

func TestSettleHexCenters(t *testing.T) {
	anchor := HexPoint{X: 100, Y: 100}
	// A stack of five hexes at 20px offsets — the pathological input a
	// raw import can carry. After settling, no pair may overlap and
	// the first (already settled) centre stays put.
	stack := []HexPoint{anchor}
	for i := 1; i < 5; i++ {
		stack = append(stack, HexPoint{X: anchor.X + float64(20*i), Y: anchor.Y + float64(20*i)})
	}
	settled := SettleHexCenters(stack)
	if len(settled) != len(stack) {
		t.Fatalf("settle changed the count: %d != %d", len(settled), len(stack))
	}
	if settled[0] != anchor {
		t.Fatalf("first centre moved: %+v", settled[0])
	}
	for i := 0; i < len(settled); i++ {
		for j := i + 1; j < len(settled); j++ {
			if HexesOverlap(settled[i], settled[j]) {
				t.Fatalf("settled hexes %d and %d still overlap: %+v / %+v", i, j, settled[i], settled[j])
			}
		}
	}
	// Non-colliding centres pass through untouched.
	apart := []HexPoint{anchor, {X: anchor.X + 1000, Y: anchor.Y}}
	settled = SettleHexCenters(apart)
	if settled[0] != apart[0] || settled[1] != apart[1] {
		t.Fatalf("separated centres must pass through: %+v", settled)
	}
}

func TestSettleHexCentersDeepBlob(t *testing.T) {
	// 200 hexes all stacked inside a single cell's footprint — a blob
	// far wider than the magnetic snap's 6-ring window once settled.
	// Repair must still terminate with zero overlaps: the settle
	// search depth scales with the population instead of giving up at
	// the snap depth.
	var stack []HexPoint
	for i := 0; i < 200; i++ {
		stack = append(stack, HexPoint{X: float64(i % 7), Y: float64(i / 7)})
	}
	settled := SettleHexCenters(stack)
	for i := 0; i < len(settled); i++ {
		for j := i + 1; j < len(settled); j++ {
			if HexesOverlap(settled[i], settled[j]) {
				t.Fatalf("hexes %d and %d still overlap after deep settle", i, j)
			}
		}
	}
}
