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
  w?: number;
  h?: number;
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

export interface StressOptions {
  /**
   * Give every box a FIXED FRAME instead of letting it auto-size to
   * its label — the path brain#258 is about. Boxes cycle through all
   * four fixed-frame silhouettes in equal quarters so one fixture
   * exercises every clamp geometry:
   *
   *   i % 4 === 0 → hexagon  (shape 1, 240×208, 0.64 usable height)
   *   i % 4 === 1 → circle   (shape 2, 208×208, 0.62)
   *   i % 4 === 2 → triangle (shape 3, 240×208, 0.40)
   *   i % 4 === 3 → resized rectangle (`nodesize`, `.sized` class)
   *
   * The first three take their size from CSS (fixedShapeSize in
   * render.ts) and only need the shape directive; the fourth carries
   * an explicit w/h. All four run the label clamp at materialization.
   */
  fixedFrame?: boolean;
}

// Resized-rectangle frames for the fixed-frame fixture. Deliberately
// varied (and deliberately too small for the longer labels) so the
// clamp has to truncate rather than trivially fitting every label on
// one line.
const SIZED_FRAMES: ReadonlyArray<readonly [number, number]> = [
  [120, 64],
  [160, 96],
  [96, 120],
  [200, 72],
];

/**
 * Build a stress map with `nBoxes` boxes on a jittered grid,
 * ~nBoxes/2 free lines, ~nBoxes/5 edges, ~nBoxes/20 texts and
 * ~nBoxes/50 strokes. Box 0 sits at (0, 0) (plus tiny jitter), so
 * the benchmark can park the cursor near the origin and know which
 * box is the proximity target.
 *
 * With `{ fixedFrame: true }` every box gets a fixed silhouette or an
 * explicit size — same geometry, same counts, same seed, so the two
 * variants are a controlled A/B of the label-clamp path and nothing
 * else.
 */
export const makeStressMap = (
  nBoxes: number,
  opts: StressOptions = {},
): FixtureMap => {
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
    // Assigned from the index, never from `rng`, so the fixed-frame
    // variant draws the exact same random sequence as the auto-sized
    // one — positions, palettes, lines, edges, texts and strokes come
    // out byte-identical and the only difference is the frame.
    if (opts.fixedFrame) {
      const kind = i % 4;
      if (kind === 3) {
        const [fw, fh] = SIZED_FRAMES[Math.floor(i / 4) % SIZED_FRAMES.length]!;
        box.w = fw;
        box.h = fh;
      } else {
        box.shape = kind + 1;
      }
    }
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

export const makeStressGraph = (
  nBoxes: number,
  opts: StressOptions = {},
): FixtureGraph => ({
  version: "1",
  maps: [makeStressMap(nBoxes, opts)],
});
