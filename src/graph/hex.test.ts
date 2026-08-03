import { describe, expect, it } from "vitest";
import {
  HEX_COL,
  HEX_H,
  HEX_ROW,
  HEX_SNAP_RADIUS,
  HEX_W,
  axialRound,
  axialToWorld,
  hexClusterIds,
  hexesOverlap,
  nearestCell,
  nearestFreeCell,
  settleHexCenters,
  snapHexCenter,
  snapHexGroup,
  worldToAxial,
} from "./hex";

describe("constants", () => {
  it("keeps the never-overlap invariant: snap radius exceeds hex width", () => {
    // Outside the magnetic range every other centre is further away
    // than a full hex width, so an un-snapped hex cannot overlap.
    expect(HEX_SNAP_RADIUS).toBeGreaterThan(HEX_W);
  });

  it("derives the lattice steps from the fixed size", () => {
    expect(HEX_COL).toBe(HEX_W * 0.75);
    expect(HEX_ROW).toBe(HEX_H);
  });
});

describe("axialToWorld / worldToAxial", () => {
  const origin = { x: 1000.25, y: -37.5 }; // deliberately off-grid

  it("round-trips every cell in a 7x7 neighbourhood", () => {
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        const c = axialToWorld(origin, { q, r });
        const f = worldToAxial(origin, c);
        expect(f.q).toBeCloseTo(q, 9);
        expect(f.r).toBeCloseTo(r, 9);
        expect(axialRound(f.q, f.r)).toEqual({ q, r });
      }
    }
  });

  it("places the +q neighbour ¾·W right and half a row down", () => {
    expect(axialToWorld(origin, { q: 1, r: 0 })).toEqual({
      x: origin.x + HEX_COL,
      y: origin.y + HEX_ROW / 2,
    });
  });

  it("places the +r neighbour one full row straight down", () => {
    expect(axialToWorld(origin, { q: 0, r: 1 })).toEqual({
      x: origin.x,
      y: origin.y + HEX_ROW,
    });
  });
});

describe("nearestCell", () => {
  const origin = { x: 0, y: 0 };

  it("maps points near a centre to that cell", () => {
    const c = axialToWorld(origin, { q: 2, r: -1 });
    expect(nearestCell(origin, { x: c.x + 10, y: c.y - 12 })).toEqual({
      q: 2,
      r: -1,
    });
  });

  it("uses cube rounding near cell boundaries (naive rounding fails here)", () => {
    // Just below the midpoint between (0,0) and its (1,0) neighbour,
    // biased so independent q/r rounding would disagree with the
    // true nearest centre.
    const a = axialToWorld(origin, { q: 0, r: 0 });
    const b = axialToWorld(origin, { q: 1, r: 0 });
    const nearA = { x: a.x + (b.x - a.x) * 0.45, y: a.y + (b.y - a.y) * 0.45 };
    const nearB = { x: a.x + (b.x - a.x) * 0.55, y: a.y + (b.y - a.y) * 0.55 };
    expect(nearestCell(origin, nearA)).toEqual({ q: 0, r: 0 });
    expect(nearestCell(origin, nearB)).toEqual({ q: 1, r: 0 });
  });
});

describe("hexesOverlap", () => {
  const o = { x: 500, y: 500 };

  it("treats exact lattice adjacency as touching, not overlapping", () => {
    for (const cell of [
      { q: 1, r: 0 },
      { q: 0, r: 1 },
      { q: 1, r: -1 },
      { q: -1, r: 1 },
    ]) {
      expect(hexesOverlap(o, axialToWorld(o, cell))).toBe(false);
    }
  });

  it("flags real intrusions", () => {
    expect(hexesOverlap(o, o)).toBe(true); // same cell
    expect(hexesOverlap(o, { x: o.x, y: o.y + HEX_H - 2 })).toBe(true);
    expect(hexesOverlap(o, { x: o.x + HEX_W - 10, y: o.y })).toBe(true);
  });

  it("clears genuinely separated hexes", () => {
    expect(hexesOverlap(o, { x: o.x, y: o.y + HEX_H + 1 })).toBe(false);
    expect(hexesOverlap(o, { x: o.x + HEX_W + 1, y: o.y })).toBe(false);
  });
});

describe("snapHexCenter", () => {
  const anchor = { x: 300.5, y: 200.5 }; // off-grid cluster anchor

  it("returns null with no other hexes (free placement)", () => {
    expect(snapHexCenter({ x: 10, y: 10 }, [])).toBeNull();
  });

  it("returns null outside the magnetic range", () => {
    const far = { x: anchor.x + HEX_SNAP_RADIUS + 1, y: anchor.y };
    expect(snapHexCenter(far, [anchor])).toBeNull();
  });

  it("snaps onto the lattice anchored at the nearest hex", () => {
    // Propose a point a little off the anchor's (1, 0) neighbour.
    const target = axialToWorld(anchor, { q: 1, r: 0 });
    const snapped = snapHexCenter(
      { x: target.x + 15, y: target.y - 20 },
      [anchor],
    );
    expect(snapped).toEqual(target);
  });

  it("picks an adjacent free cell when the nearest cell is occupied", () => {
    // Proposing exactly the anchor's own centre: cell (0,0) is
    // blocked, so the snap must land on one of the six neighbours —
    // flush against the anchor, not on top of it.
    const snapped = snapHexCenter({ x: anchor.x, y: anchor.y }, [anchor]);
    expect(snapped).not.toBeNull();
    expect(hexesOverlap(snapped!, anchor)).toBe(false);
    const d = Math.hypot(snapped!.x - anchor.x, snapped!.y - anchor.y);
    expect(d).toBeLessThanOrEqual(HEX_ROW + 1); // adjacent, not flung away
  });

  it("skips cells blocked by an off-lattice intruder", () => {
    // The (1, 0) neighbour cell is straddled by an off-lattice hex;
    // proposing near that cell must yield some other, free cell.
    const blockedCell = axialToWorld(anchor, { q: 1, r: 0 });
    const intruder = { x: blockedCell.x + 5, y: blockedCell.y - 3 };
    const snapped = snapHexCenter(
      { x: blockedCell.x + 1, y: blockedCell.y + 1 },
      [anchor, intruder],
    );
    expect(snapped).not.toBeNull();
    expect(hexesOverlap(snapped!, anchor)).toBe(false);
    expect(hexesOverlap(snapped!, intruder)).toBe(false);
  });
});

describe("nearestFreeCell", () => {
  const origin = { x: 0, y: 0 };

  it("returns the containing cell when it is free", () => {
    expect(nearestFreeCell(origin, { x: 3, y: -4 }, [])).toEqual({
      q: 0,
      r: 0,
    });
  });

  it("walks outward past a fully blocked first ring", () => {
    // Occupy the centre and all six neighbours; the nearest free cell
    // must come from ring 2.
    const occupied = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ].map((c) => axialToWorld(origin, c));
    const cell = nearestFreeCell(origin, { x: 0, y: 0 }, occupied);
    expect(cell).not.toBeNull();
    const world = axialToWorld(origin, cell!);
    for (const o of occupied) {
      expect(hexesOverlap(world, o)).toBe(false);
    }
  });
});

describe("settleHexCenters", () => {
  it("leaves non-overlapping input untouched", () => {
    const input = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 0, y: 400 },
    ];
    expect(settleHexCenters(input)).toEqual(input);
  });

  it("moves a colliding hex to an adjacent free cell", () => {
    const a = { x: 100, y: 100 };
    const b = { x: 110, y: 95 }; // clearly overlapping a
    const [ra, rb] = settleHexCenters([a, b]);
    expect(ra).toEqual(a); // first one wins its spot
    expect(hexesOverlap(ra!, rb!)).toBe(false);
    // Settled flush on a's lattice: adjacent, not teleported.
    const d = Math.hypot(rb!.x - a.x, rb!.y - a.y);
    expect(d).toBeLessThanOrEqual(HEX_ROW + 1);
  });

  it("resolves a pile-up of several hexes with no residual overlap", () => {
    const pile = [
      { x: 50, y: 50 },
      { x: 55, y: 52 },
      { x: 48, y: 60 },
      { x: 60, y: 45 },
    ];
    const out = settleHexCenters(pile);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(hexesOverlap(out[i]!, out[j]!)).toBe(false);
      }
    }
  });
});

describe("hexClusterIds", () => {
  const hex = (id: string, x: number, y: number) => ({ id, x, y, shape: 1 });

  it("collects a chain of lattice-adjacent hexes", () => {
    // a-(col step)-b-(row step)-c, d far away
    const boxes = [
      hex("a", 0, 0),
      hex("b", HEX_COL, 104),   // +q neighbour
      hex("c", HEX_COL, 312),   // +r from b
      hex("d", 1000, 1000),
    ];
    expect(new Set(hexClusterIds(boxes, "a"))).toEqual(new Set(["a", "b", "c"]));
    expect(new Set(hexClusterIds(boxes, "c"))).toEqual(new Set(["a", "b", "c"]));
    expect(hexClusterIds(boxes, "d")).toEqual(["d"]);
  });

  it("ignores rectangles even when they sit between hexes", () => {
    const boxes = [
      hex("a", 0, 0),
      { id: "r", x: HEX_COL, y: 104, shape: 0 },
      hex("b", 2 * HEX_COL, 208),
    ];
    expect(hexClusterIds(boxes, "a")).toEqual(["a"]);
  });

  it("tolerates slightly off-lattice snapped positions", () => {
    const boxes = [hex("a", 0, 0), hex("b", HEX_COL + 9, 104 + 8)];
    expect(new Set(hexClusterIds(boxes, "a"))).toEqual(new Set(["a", "b"]));
  });

  it("returns just the start id for unknown / non-hex starts", () => {
    expect(hexClusterIds([{ id: "r", x: 0, y: 0, shape: 0 }], "r")).toEqual(["r"]);
  });
});

describe("snapHexGroup", () => {
  const obstacle = { x: 0, y: 0 };

  it("snaps the whole formation by one delta, preserving offsets", () => {
    // Two flush neighbours (+q, +q+r) hovering near an obstacle,
    // slightly off-lattice.
    const members = [
      { x: HEX_COL + 11, y: 104 + 7 },
      { x: HEX_COL + 11, y: 312 + 7 },
    ];
    const delta = snapHexGroup(members, [obstacle]);
    expect(delta).not.toBeNull();
    // The elected reference (closest member) lands exactly on its cell…
    expect(members[0]!.x + delta!.x).toBeCloseTo(HEX_COL, 6);
    expect(members[0]!.y + delta!.y).toBeCloseTo(104, 6);
    // …and the second member keeps its exact relative offset (rigid).
    expect(members[1]!.x + delta!.x - (members[0]!.x + delta!.x)).toBeCloseTo(0, 9);
    expect(members[1]!.y + delta!.y - (members[0]!.y + delta!.y)).toBeCloseTo(208, 9);
  });

  it("returns null when the whole group is out of magnetic range", () => {
    const members = [
      { x: 2000, y: 2000 },
      { x: 2000 + HEX_COL, y: 2104 },
    ];
    expect(snapHexGroup(members, [obstacle])).toBeNull();
  });

  it("skips placements where any member would overlap, without deforming", () => {
    // The obstacle's +q cell is where the reference wants to go, but a
    // second obstacle occupies the cell the OTHER member would land on.
    // The group must take a placement where BOTH fit — same delta —
    // rather than splitting up.
    const blocking = { x: HEX_COL, y: 312 }; // +q+r cell
    const members = [
      { x: HEX_COL + 9, y: 104 + 5 },
      { x: HEX_COL + 9, y: 312 + 5 },
    ];
    const delta = snapHexGroup(members, [obstacle, blocking]);
    expect(delta).not.toBeNull();
    const placed = members.map((m) => ({ x: m.x + delta!.x, y: m.y + delta!.y }));
    for (const p of placed) {
      expect(hexesOverlap(p, obstacle)).toBe(false);
      expect(hexesOverlap(p, blocking)).toBe(false);
    }
    // Rigid: relative offset unchanged.
    expect(placed[1]!.x - placed[0]!.x).toBeCloseTo(0, 9);
    expect(placed[1]!.y - placed[0]!.y).toBeCloseTo(208, 9);
  });

  it("returns null with no obstacles (nothing to anchor to)", () => {
    expect(snapHexGroup([{ x: 5, y: 5 }], [])).toBeNull();
  });
});
