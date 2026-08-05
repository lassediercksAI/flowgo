// Synthetic stress-map generator for the perf smoke benchmark
// (perf-smoke.perf.ts) and for manual browser profiling
// (`just perf-fixture` writes it out as a .flowgo file).
//
// Deterministic on purpose: a seeded LCG instead of Math.random so
// every run — local or CI — renders the exact same map and the
// counter metrics are reproducible to the digit.
//
// The shape of the map mirrors what made the real-world
// mini_stresstest.flowgo slow (see brain #236–#23a): thousands of
// boxes spread over a large extent, a pile of lines (some with mids /
// curved styles), edges between neighbouring boxes, plus a sprinkle
// of texts and strokes so every render layer has work to do.

export interface FixtureBox {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  shape?: number;
}

export interface FixtureText {
  id: string;
  label: string;
  x: number;
  y: number;
}

export interface FixtureLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
  style?: number;
}

export interface FixtureEdge {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
}

export interface FixtureStroke {
  id: string;
  points: Array<[number, number]>;
}

export interface FixtureMap {
  path: string;
  boxes: FixtureBox[];
  edges: FixtureEdge[];
  texts: FixtureText[];
  lines: FixtureLine[];
  strokes: FixtureStroke[];
}

export interface FixtureGraph {
  version: string;
  maps: FixtureMap[];
}

// Grid geometry — exported so the benchmark can aim the synthetic
// cursor at a known box without re-deriving the layout.
export const GRID_X = 200;
export const GRID_Y = 140;

// Deterministic 32-bit LCG (Numerical Recipes constants).
const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

/**
 * Build a stress map with `nBoxes` boxes on a jittered grid,
 * ~nBoxes/2 free lines, ~nBoxes/5 edges, ~nBoxes/20 texts and
 * ~nBoxes/50 strokes. Box 0 sits at (0, 0) (plus tiny jitter), so
 * the benchmark can park the cursor near the origin and know which
 * box is the proximity target.
 */
export const makeStressMap = (nBoxes: number): FixtureMap => {
  const rng = makeRng(0xf10460 + nBoxes);
  const cols = Math.ceil(Math.sqrt(nBoxes));
  const extentX = cols * GRID_X;
  const extentY = Math.ceil(nBoxes / cols) * GRID_Y;

  const boxes: FixtureBox[] = [];
  for (let i = 0; i < nBoxes; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const box: FixtureBox = {
      id: "b" + i,
      // Mix of short and multi-word labels so label spans differ.
      label: i % 7 === 0 ? "stress node " + i : "n" + i,
      x: col * GRID_X + Math.floor(rng() * 40),
      y: row * GRID_Y + Math.floor(rng() * 30),
    };
    const palette = 1 + Math.floor(rng() * 9);
    if (palette !== 1) box.palette = palette;
    boxes.push(box);
  }

  const edges: FixtureEdge[] = [];
  const nEdges = Math.floor(nBoxes / 5);
  for (let i = 0; i < nEdges; i++) {
    // Connect grid neighbours so edges stay short, like a real map.
    const from = Math.floor(rng() * (nBoxes - 1));
    edges.push({ from: "b" + from, to: "b" + (from + 1) });
  }

  const lines: FixtureLine[] = [];
  const nLines = Math.floor(nBoxes / 2);
  for (let i = 0; i < nLines; i++) {
    const line: FixtureLine = {
      id: "l" + i,
      x1: Math.floor(rng() * extentX),
      y1: Math.floor(rng() * extentY),
      x2: Math.floor(rng() * extentX),
      y2: Math.floor(rng() * extentY),
    };
    if (i % 3 === 0) {
      line.mids = [
        [Math.floor(rng() * extentX), Math.floor(rng() * extentY)],
      ];
      line.style = i % 6 === 0 ? 2 : 3;
    }
    lines.push(line);
  }

  const texts: FixtureText[] = [];
  const nTexts = Math.floor(nBoxes / 20);
  for (let i = 0; i < nTexts; i++) {
    texts.push({
      id: "t" + i,
      label: "note " + i,
      x: Math.floor(rng() * extentX),
      y: Math.floor(rng() * extentY),
    });
  }

  const strokes: FixtureStroke[] = [];
  const nStrokes = Math.floor(nBoxes / 50);
  for (let i = 0; i < nStrokes; i++) {
    const points: Array<[number, number]> = [];
    let px = Math.floor(rng() * extentX);
    let py = Math.floor(rng() * extentY);
    for (let p = 0; p < 12; p++) {
      px += Math.floor(rng() * 30) - 15;
      py += Math.floor(rng() * 30) - 15;
      points.push([px, py]);
    }
    strokes.push({ id: "s" + i, points });
  }

  return { path: "/", boxes, edges, texts, lines, strokes };
};

export const makeStressGraph = (nBoxes: number): FixtureGraph => ({
  version: "1",
  maps: [makeStressMap(nBoxes)],
});
