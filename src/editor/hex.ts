// Hexagon setting: while enabled, a double-click (or touch double-tap)
// on empty canvas spawns a fixed-size hexagonal box instead of a
// normal auto-sized rectangle. Unlike brush/line — which are transient
// tool modes — this is a persistent per-browser preference: it lives
// in localStorage, survives reloads, and is flipped from the settings
// popover (⚙, desktop) or the mode bar's hexagon latch (touch), never
// from a transient keyboard mode. factories.ts consults `isHexMode()`
// inside createBoxAt so every box-creation path honours it.
//
// What makes hexagons special (see src/graph/hex.ts for the math):
//   • uniform size — every hex is HEX_W × HEX_H, never resizable;
//   • magnetic — within HEX_SNAP_RADIUS of another hexagon they snap
//     onto the flat-top lattice anchored at that hexagon, so edges
//     land flush;
//   • never overlapping — the snap picks the nearest FREE cell, and
//     settleHexBoxes() repairs any overlap the live snap could not
//     prevent (multi-select drags, paste offsets) at commit time.

import {
  HEX_H,
  HEX_W,
  settleHexCenters,
  type HexPoint,
} from "../graph/hex.ts";

interface HexBoxLike {
  id: string;
  x: number;
  y: number;
  shape?: number | undefined;
}

interface HexBindings {
  readonly setStatus: (s: string) => void;
}

let bindings: HexBindings | null = null;
const must = (): HexBindings => {
  if (!bindings) throw new Error("hex: wireHex() not called");
  return bindings;
};

// localStorage key for the persisted preference. Read failures (e.g.
// privacy modes that throw on access) degrade to "off" — the shipped
// default.
const STORAGE_KEY = "flowgo.hexagons";

let hexMode = ((): boolean => {
  // Import-safe outside the browser (vitest runs in a bare Node
  // environment and other editor modules import this one
  // transitively) — no window means no preference, plain default.
  if (typeof window === "undefined") return false;
  // `flowgo --hexagon` injects window.FLOWGO_HEXAGON = true into the
  // served page — an explicit CLI opt-in wins over any stored
  // preference for this session (and persists below, so subsequent
  // sessions without the flag keep it until the user toggles off).
  const forced =
    (window as { FLOWGO_HEXAGON?: unknown }).FLOWGO_HEXAGON === true;
  try {
    if (forced) {
      localStorage.setItem(STORAGE_KEY, "1");
      return true;
    }
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return forced;
  }
})();

export const wireHex = (b: HexBindings): void => {
  bindings = b;
  // Project the persisted value onto the DOM at boot — setHexMode's
  // change-guard means a stored "on" would otherwise never apply its
  // body class (used by the crosshair cursor CSS).
  document.body.classList.toggle("hex-mode", hexMode);
};

export const isHexMode = (): boolean => hexMode;

export const setHexMode = (on: boolean): void => {
  if (hexMode === on) return;
  hexMode = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Setting persists for the session only; still fully functional.
  }
  document.body.classList.toggle("hex-mode", hexMode);
  must().setStatus(
    hexMode
      ? "hexagons on — double-click adds a hexagon"
      : "hexagons off — double-click adds a box",
  );
};

// Centres of every hexagon box, minus any excluded ids (the dragged
// selection excludes itself so it doesn't snap against its own
// members). Boxes store their top-left; the lattice works on centres.
export const hexCenters = (
  boxes: ReadonlyArray<HexBoxLike>,
  exclude?: ReadonlySet<string>,
): HexPoint[] =>
  boxes
    .filter((b) => b.shape === 1 && !(exclude?.has(b.id) ?? false))
    .map((b) => ({ x: b.x + HEX_W / 2, y: b.y + HEX_H / 2 }));

// Post-commit invariant repair: relocate any hexagon that overlaps an
// earlier one onto the nearest free lattice cell (anchored at the hex
// it collided with). Mutates box positions in place; returns whether
// anything moved so the caller knows to re-render.
export const settleHexBoxes = (boxes: ReadonlyArray<HexBoxLike>): boolean => {
  const hexes = boxes.filter((b) => b.shape === 1);
  if (hexes.length < 2) return false;
  const settled = settleHexCenters(
    hexes.map((b) => ({ x: b.x + HEX_W / 2, y: b.y + HEX_H / 2 })),
  );
  let changed = false;
  hexes.forEach((b, i) => {
    const c = settled[i]!;
    const nx = c.x - HEX_W / 2;
    const ny = c.y - HEX_H / 2;
    if (nx !== b.x || ny !== b.y) {
      b.x = nx;
      b.y = ny;
      changed = true;
    }
  });
  return changed;
};
