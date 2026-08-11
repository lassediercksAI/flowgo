// Pure hex-lattice math for hexagon-mode boxes — the Go port of
// src/graph/hex.ts. Keep the two in lockstep: same constants, same
// axial conventions, same never-overlap invariant. The editor uses
// the TS side for live drag-snap; this side lets the MCP tools honour
// the identical contract when an agent (not a pointer) places hexes.
//
// Hexagons are uniform, flat-top, and never resizable: HexW × HexH
// CSS pixels. The lattice is implicit and LOCAL: there is no world
// origin — snapping anchors the lattice at the centre of the nearest
// existing hexagon. Axial coordinates (q, r) follow the redblobgames
// flat-top convention.
//
// Key invariant: HexSnapRadius > HexW. Inside the radius a hex snaps
// onto a free cell (so it cannot overlap); outside it, its centre is
// more than a full hex width from every other centre, which makes
// overlap physically impossible. Either way two hexagons never
// overlap.
package graph

import "math"

const (
	// HexW / HexH: fixed footprint of every hexagon (flat-top;
	// H = W·√3/2 rounded to a whole pixel — see hex.ts).
	HexW = 240.0
	HexH = 208.0

	// Centre-to-centre lattice steps: +q is 0.75·W right and half a
	// row down; +r is one full row straight down.
	HexCol = HexW * 0.75 // 180
	HexRow = HexH        // 208

	// Magnetic range: snapping engages when a proposed centre comes
	// within this distance of another hexagon's centre.
	HexSnapRadius = HexW * 1.01 // 242.4

	// How far (in rings) the magnetic snap searches for a free cell
	// before giving up. Deliberately shallow: a snap target far from
	// the proposed position would feel like teleportation, so out of
	// nearby cells means "stay where the user/agent put it".
	maxSnapRings = 6

	// Hard ceiling for the settle path's population-scaled search
	// (see settleRings). 64 rings is 12,481 cells — enough to re-seat
	// ~3,000 fully stacked hexagons; beyond that settling degrades to
	// best-effort rather than costing quadratic blow-up.
	maxSettleRings = 64

	// Float-dust tolerance for the overlap test.
	hexEps = 1e-6
)

// HexPoint is a world-space point (a hexagon centre, mostly).
type HexPoint struct {
	X float64
	Y float64
}

// Axial is a lattice cell in axial coordinates.
type Axial struct {
	Q int
	R int
}

// AxialToWorld converts a cell to its world centre, for a lattice
// anchored at origin (itself cell (0,0)).
func AxialToWorld(origin HexPoint, cell Axial) HexPoint {
	return HexPoint{
		X: origin.X + float64(cell.Q)*HexCol,
		Y: origin.Y + (float64(cell.R)+float64(cell.Q)/2)*HexRow,
	}
}

// WorldToAxial converts a world point to fractional axial coordinates
// on the lattice anchored at origin. Fractional on purpose: feed
// through AxialRound to get the containing cell.
func WorldToAxial(origin HexPoint, p HexPoint) (q, r float64) {
	q = (p.X - origin.X) / HexCol
	r = (p.Y-origin.Y)/HexRow - q/2
	return q, r
}

// AxialRound rounds fractional axial coordinates to the nearest cell
// via cube rounding: round all three cube coords, then fix the one
// with the largest rounding error so q + r + s stays 0. Plain
// independent rounding picks the wrong cell near boundaries.
func AxialRound(q, r float64) Axial {
	s := -q - r
	rq := math.Round(q)
	rr := math.Round(r)
	rs := math.Round(s)
	dq := math.Abs(rq - q)
	dr := math.Abs(rr - r)
	ds := math.Abs(rs - s)
	if dq > dr && dq > ds {
		rq = -rr - rs
	} else if dr > ds {
		rr = -rq - rs
	}
	return Axial{Q: int(rq), R: int(rr)}
}

// NearestCell returns the lattice cell nearest to world point p on
// the lattice anchored at origin.
func NearestCell(origin HexPoint, p HexPoint) Axial {
	q, r := WorldToAxial(origin, p)
	return AxialRound(q, r)
}

// HexesOverlap reports whether two fixed-size flat-top hexagons
// centred at a and b overlap. Closed-form separating-axis result:
// the Minkowski sum of the hex with itself is the same hexagon scaled
// 2×, so the centres overlap iff their difference lies strictly
// inside that 2× hexagon. Exact edge-to-edge contact (adjacent
// lattice cells) counts as NOT overlapping.
func HexesOverlap(a, b HexPoint) bool {
	dx := math.Abs(a.X - b.X)
	dy := math.Abs(a.Y - b.Y)
	if dy >= HexH-hexEps {
		return false
	}
	return HexH*dx+(HexW/2)*dy < HexW*HexH-hexEps
}

// The six axial direction vectors, in ring-walk order.
var axialDirs = [6]Axial{
	{Q: 1, R: 0},
	{Q: 1, R: -1},
	{Q: 0, R: -1},
	{Q: -1, R: 0},
	{Q: -1, R: 1},
	{Q: 0, R: 1},
}

// hexRing returns all cells at exactly radius steps from center
// (radius 0 → just the centre). Standard hex ring walk.
func hexRing(center Axial, radius int) []Axial {
	if radius == 0 {
		return []Axial{center}
	}
	out := make([]Axial, 0, 6*radius)
	cur := Axial{
		Q: center.Q + axialDirs[4].Q*radius,
		R: center.R + axialDirs[4].R*radius,
	}
	for side := 0; side < 6; side++ {
		d := axialDirs[side]
		for step := 0; step < radius; step++ {
			out = append(out, cur)
			cur = Axial{Q: cur.Q + d.Q, R: cur.R + d.R}
		}
	}
	return out
}

// settleRings picks a search depth deep enough that a free cell is
// guaranteed to exist within it: an off-lattice hexagon blocks at
// most 4 cells of any given lattice (its 2× Minkowski hexagon has 4
// hexes of area), so covering 4·(n+1) cells always leaves one free.
// Rings through radius R hold 1+3R(R+1) cells; solving for R gives
// ~sqrt(4n/3). Floored at the snap depth, capped at maxSettleRings.
func settleRings(occupied int) int {
	r := int(math.Ceil(math.Sqrt(4*float64(occupied+1)/3))) + 1
	if r < maxSnapRings {
		r = maxSnapRings
	}
	if r > maxSettleRings {
		r = maxSettleRings
	}
	return r
}

// NearestFreeCell finds the free cell nearest to world point p on the
// lattice anchored at origin. A cell is free when a hexagon centred
// there would overlap none of the occupied centres. Searches outward
// ring by ring up to maxRings; within the first ring with any free
// cell, picks the one closest to p. Returns (Axial{}, false) when
// every cell inside maxRings is blocked.
func NearestFreeCell(origin HexPoint, p HexPoint, occupied []HexPoint, maxRings int) (Axial, bool) {
	start := NearestCell(origin, p)
	for radius := 0; radius <= maxRings; radius++ {
		var best Axial
		found := false
		bestD := math.Inf(1)
		for _, cell := range hexRing(start, radius) {
			c := AxialToWorld(origin, cell)
			blocked := false
			for _, o := range occupied {
				if HexesOverlap(c, o) {
					blocked = true
					break
				}
			}
			if blocked {
				continue
			}
			d := math.Hypot(c.X-p.X, c.Y-p.Y)
			if d < bestD {
				bestD = d
				best = cell
				found = true
			}
		}
		if found {
			return best, true
		}
	}
	return Axial{}, false
}

// SnapHexCenter is the magnetic snap: given a proposed hex centre and
// the centres of every OTHER hexagon on the map, returns the snapped
// centre and true — or false when the hex is out of magnetic range
// (or no nearby cell is free) and should stay exactly where it was
// proposed. The lattice is anchored at the nearest other hex, so the
// snapped hex always lands flush against it.
func SnapHexCenter(proposed HexPoint, others []HexPoint) (HexPoint, bool) {
	if len(others) == 0 {
		return HexPoint{}, false
	}
	nearest := others[0]
	nearestD := math.Inf(1)
	for _, o := range others {
		d := math.Hypot(o.X-proposed.X, o.Y-proposed.Y)
		if d < nearestD {
			nearestD = d
			nearest = o
		}
	}
	if nearestD > HexSnapRadius {
		return HexPoint{}, false
	}
	cell, ok := NearestFreeCell(nearest, proposed, others, maxSnapRings)
	if !ok {
		return HexPoint{}, false
	}
	return AxialToWorld(nearest, cell), true
}

// SettleHexCenters is the invariant repair for centres that arrived
// without live snapping (raw imports, set_state): walk the centres in
// order and relocate any hex that overlaps an earlier (already
// settled) one to the nearest free cell on the lattice anchored at
// the hex it collided with. Returns a new slice; non-colliding
// centres pass through untouched.
//
// Unlike the magnetic snap, repair must not give up just because the
// neighbourhood is crowded — a stress import can stack hexes inside a
// blob far wider than the snap's 6-ring window — so the search depth
// scales with the population (settleRings).
func SettleHexCenters(centers []HexPoint) []HexPoint {
	rings := settleRings(len(centers))
	settled := make([]HexPoint, 0, len(centers))
	for _, c := range centers {
		collided := false
		var anchor HexPoint
		for _, s := range settled {
			if HexesOverlap(s, c) {
				collided = true
				anchor = s
				break
			}
		}
		if !collided {
			settled = append(settled, c)
			continue
		}
		cell, ok := NearestFreeCell(anchor, c, settled, rings)
		if ok {
			settled = append(settled, AxialToWorld(anchor, cell))
		} else {
			settled = append(settled, c)
		}
	}
	return settled
}
