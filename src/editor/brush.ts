// Brush mode: free-hand stroke painting on the background. Owns the
// `brushMode` toggle and the in-flight `activeStroke`. main.ts reads
// `isBrushMode()` and `isPainting()` to gate other interactions, and
// dispatches mousedown/move/up to the start/extend/finish trio.

import { simplifyStroke } from "../index.ts";
import { mutatedStroke } from "./mutations.ts";
import { toDataX, toDataY } from "./viewport.ts";

interface ActiveStroke {
  readonly id: string;
  readonly palette: number;
  points: Array<readonly [number, number]>;
  readonly polyEl: SVGPolylineElement;
}

interface BrushBindings {
  readonly mintId: () => string;
  readonly strokeLayer: () => SVGGElement;
  readonly currentMap: () => { strokes?: Array<unknown> };
  /** Called after a stroke finishes. `committedId` is the id of the
   *  stroke just added to the map, or null when the stroke was too
   *  short to keep — so the caller can materialize just the new
   *  stroke (render.ts renderItems, #238) instead of rebuilding the
   *  whole layer. */
  readonly afterCommit: (committedId: string | null) => void;
  readonly setStatus: (s: string) => void;
}

let bindings: BrushBindings | null = null;
export const wireBrush = (b: BrushBindings): void => {
  bindings = b;
};
const must = (): BrushBindings => {
  if (!bindings) throw new Error("brush: wireBrush() not called");
  return bindings;
};

let brushMode = false;
let active: ActiveStroke | null = null;
// 1 = default colour (no palette class persisted). 2..9 are styled.
let palette = 1;

export const isBrushMode = (): boolean => brushMode;
export const isPainting = (): boolean => active !== null;
export const getBrushPalette = (): number => palette;

// Pencil-body fill per palette. Matches the darker `.box.palette-N`
// border colour so the cursor reads as the same hue the stroke will
// render in. Keep in sync with the `.stroke-group.palette-N` CSS.
// Palette 2 mirrors the "white-on-black" box treatment: a white stroke
// with a black halo (see `.stroke-group.palette-2` in index.html). The
// cursor uses white fill so the body matches the stroke colour; the
// SVG already paints a 1px black outline around the pencil body, which
// keeps the white pencil visible against the white canvas.
const PENCIL_BODY: Record<number, string> = {
  1: "#333",
  2: "#1d4ed8",
  3: "#6d28d9",
  4: "#15803d",
  5: "#a16207",
  6: "#b91c1c",
  7: "#c2410c",
  8: "#374151",
  9: "#fff",
};

// Exported for direct testing — pure string builder.
export const cursorForPalette = (p: number): string => {
  const body = PENCIL_BODY[p] ?? PENCIL_BODY[1]!;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>`
    + `<path d='M3 21l3-1 9-9-2-2-9 9-1 3z' fill='${body}' stroke='%23000' stroke-width='1'/>`
    + `<path d='M14 9l4-4-2-2-4 4z' fill='%23a60' stroke='%23000' stroke-width='1'/>`
    + `</svg>`;
  // `#` is special in data URIs; escape it for the colour hashes.
  const encoded = svg.replace(/#/g, "%23");
  return `url("data:image/svg+xml;utf8,${encoded}") 2 22, crosshair`;
};

// The static CSS sets the default-grey pencil on body and on every
// element with its own `cursor:` rule (canvas, .box, .text-item, …) so
// the brush mode reads consistently regardless of hover target. To
// recolour the pencil without touching the static stylesheet we inject
// (and update) one extra style block that overrides the same selectors
// for the active palette. Removing the block reverts to the static
// default-grey rule.
let cursorStyleEl: HTMLStyleElement | null = null;
const applyCursor = (): void => {
  if (!brushMode || palette === 1) {
    if (cursorStyleEl) cursorStyleEl.textContent = "";
    return;
  }
  if (!cursorStyleEl) {
    cursorStyleEl = document.createElement("style");
    cursorStyleEl.id = "brush-cursor-dynamic";
    document.head.appendChild(cursorStyleEl);
  }
  const c = cursorForPalette(palette);
  cursorStyleEl.textContent =
    `body.brush-mode,`
    + `body.brush-mode #bg-layer,`
    + `body.brush-mode #canvas,`
    + `body.brush-mode .box,`
    + `body.brush-mode .text-item { cursor: ${c}; }`;
};

export const setBrushMode = (on: boolean): void => {
  if (brushMode === on) return;
  brushMode = on;
  document.body.classList.toggle("brush-mode", brushMode);
  applyCursor();
  must().setStatus(brushMode ? "brush mode — drag to paint, V to exit" : "select mode");
};

export const setBrushPalette = (p: number): void => {
  if (p < 1 || p > 9) return;
  palette = p;
  if (brushMode) applyCursor();
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Pure helpers (exported for direct testing) ──────────────────

export const previewPoints = (pts: ReadonlyArray<readonly [number, number]>): string =>
  pts.map((p) => `${p[0]},${p[1]}`).join(" ");

// Min-distance filter for the in-flight stroke: a sample under 2 DATA
// units from the last kept point is hand jitter and is dropped. Data
// units, not client px, so zooming in doesn't make strokes denser.
export const passesMinDistance = (
  last: readonly [number, number],
  x: number,
  y: number,
): boolean => Math.hypot(x - last[0], y - last[1]) >= 2;

export const startStroke = (clientX: number, clientY: number): void => {
  const x = round2(toDataX(clientX));
  const y = round2(toDataY(clientY));
  const id = must().mintId();
  const ns = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(ns, "g");
  const cls = "stroke-group" + (palette >= 2 ? ` palette-${palette}` : "");
  g.setAttribute("class", cls);
  g.dataset["id"] = id;
  const poly = document.createElementNS(ns, "polyline");
  poly.setAttribute("class", "stroke-line");
  poly.setAttribute("points", `${x},${y}`);
  g.appendChild(poly);
  must().strokeLayer().appendChild(g);
  active = { id, palette, points: [[x, y]], polyEl: poly };
};

export const extendStroke = (clientX: number, clientY: number): void => {
  if (!active) return;
  const x = round2(toDataX(clientX));
  const y = round2(toDataY(clientY));
  const last = active.points[active.points.length - 1]!;
  if (!passesMinDistance(last, x, y)) return;
  active.points.push([x, y]);
  active.polyEl.setAttribute("points", previewPoints(active.points));
};

// Throw away an in-flight stroke without committing it. Used when a
// second finger lands mid-stroke (brain#24c): the user is starting a
// pinch, not painting, and the first finger's few millimetres of
// travel must not survive as a stray mark. Distinct from
// finishStroke(), which is still the right call for touchcancel — an
// interrupted-but-intentional stroke should keep whatever it drew.
export const abandonStroke = (): void => {
  if (!active) return;
  const g = active.polyEl.parentNode;
  if (g && g.parentNode) g.parentNode.removeChild(g);
  active = null;
};

export const finishStroke = (): void => {
  if (!active) return;
  // ε ≈ 1.5px — drops hand-tremor samples without rounding intentional curves.
  const simplified = simplifyStroke(active.points, 1.5);
  // The live preview polyline group is throwaway either way: on
  // commit the renderer builds the real stroke group from state
  // (previously the full renderStrokes wiped it along with the
  // layer; the incremental path doesn't wipe, so remove it here).
  const g = active.polyEl.parentNode;
  if (g && g.parentNode) g.parentNode.removeChild(g);
  let committedId: string | null = null;
  if (simplified.length >= 2) {
    const m = must().currentMap();
    const stroke: { id: string; points: typeof simplified; palette?: number } = {
      id: active.id,
      points: simplified,
    };
    if (active.palette >= 2) stroke.palette = active.palette;
    (m.strokes ??= []).push(stroke);
    mutatedStroke();
    committedId = stroke.id;
  }
  active = null;
  must().afterCommit(committedId);
};
