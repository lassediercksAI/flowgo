// Touch-only context bar: pinned to the bottom-centre of the canvas.
// Successor to modebar.ts (right-edge, mode-only) — same job of
// giving coarse-pointer users the mode switch keyboard users hit with
// V / B / L / T, but it also grows a contextual control cluster for
// whichever mode is active:
//
//   - cursor mode, boxes selected: a shape row (rect/circle/triangle/
//                  hexagon) applying to every selected box — the
//                  touch-reachable equivalent of Alt+1..4 (#209; the
//                  ⬡ latch this replaced was retired in #208).
//   - cursor mode, nothing selected: the same shape row, but it sets
//                  the FILE's default shape instead (what a
//                  double-click/double-tap creates) — mirrors Alt+1..4
//                  with no selection.
//   - text mode:   + a font-size stepper and palette swatches for the
//                  NEXT text item placed.
//   - line mode:   + a line-style picker (straight/bezier/orthogonal)
//                  and palette swatches for the NEXT line drawn.
//   - brush mode:  + palette swatches for the NEXT stroke painted.
//
// "Size" only has a real meaning for text today (the font 1-9 ladder);
// line has no width property, so its second dimension is style
// instead. Brush strokes have no adjustable width in the current file
// format at all — only palette. Extending brush with a real width
// property is a file-format change, out of scope here.
//
// Mode buttons stay visible in every mode (not just cursor) so
// switching modes never requires falling back to the keyboard — the
// spec's "when in default, show all modes" is satisfied by never
// hiding them, and "when in text/line/brush, show current selected
// size and color" is satisfied by the appended cluster.
//
// Visibility is controlled by CSS (`body.touch-input #contextBar`) so
// the bar simply doesn't render on fine-pointer devices, same as
// modebar.ts before it.

import { isBrushMode, setBrushMode, getBrushPalette, setBrushPalette } from "./brush.ts";
import {
  getLinePalette,
  getLineStyle,
  isLineMode,
  setLineMode,
  setLinePalette,
  setLineStyle,
} from "./line.ts";
import {
  getTextFont,
  getTextPalette,
  isTextMode,
  setTextFont,
  setTextMode,
  setTextPalette,
} from "./text-mode.ts";
import { icon } from "./icons.ts";
import { getDefaultShape, setDefaultShape } from "./default-shape.ts";

interface BoxLike {
  readonly id: string;
  readonly shape?: number;
}

interface ContextBarBindings {
  readonly selected: Set<string>;
  readonly currentMap: () => { boxes: BoxLike[] };
  // Passed in rather than imported directly from keys.ts: render.ts
  // already imports this module (to call refreshContextBar from
  // applyClasses), and keys.ts imports render.ts — importing keys.ts
  // here too would close that into a module cycle. main.ts, which
  // already imports both, wires the function through instead.
  readonly applyShapeToSelection: (shape: number) => boolean;
}

let ctxBindings: ContextBarBindings | null = null;
export const wireContextBar = (b: ContextBarBindings): void => {
  ctxBindings = b;
};

// Called from render.ts's applyClasses() whenever the selection
// changes, so the bar's shape row flips between "sets the selection's
// shape" and "sets the file's default shape" the moment a box gets
// selected or deselected — mirrors align.ts's updateSelectionToolbar.
let syncFn: (() => void) | null = null;
export const refreshContextBar = (): void => {
  syncFn?.();
};

type Mode = "cursor" | "brush" | "line" | "text";

const currentMode = (): Mode => {
  if (isBrushMode()) return "brush";
  if (isLineMode()) return "line";
  if (isTextMode()) return "text";
  return "cursor";
};

const setMode = (m: Mode): void => {
  setBrushMode(m === "brush");
  setLineMode(m === "line");
  setTextMode(m === "text");
};

// Swatch colours mirror brush.ts's PENCIL_BODY / the .palette-N CSS
// border colours — the representative hue for each palette index.
// Duplicated rather than imported: the app already repeats this table
// per CSS rule (box / text / line / stroke each restate the nine
// hexes), so a fourth JS-side copy matches the existing convention.
const SWATCH_COLOR: Record<number, string> = {
  1: "#fff",
  2: "#1d4ed8",
  3: "#6d28d9",
  4: "#15803d",
  5: "#a16207",
  6: "#b91c1c",
  7: "#c2410c",
  8: "#374151",
  9: "#111",
};

const buildPaletteRow = (set: (p: number) => void, sync: () => void): HTMLElement => {
  const row = document.createElement("div");
  row.className = "ctx-row ctx-swatches";
  for (let p = 1; p <= 9; p++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-swatch";
    btn.style.background = SWATCH_COLOR[p]!;
    btn.title = p === 1 ? "Default colour" : `Colour ${p}`;
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btn.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      e.preventDefault();
      set(p);
      sync();
    });
    row.appendChild(btn);
  }
  return row;
};

const buildStepper = (
  label: string,
  get: () => number,
  set: (v: number) => void,
  sync: () => void,
): HTMLElement => {
  const row = document.createElement("div");
  row.className = "ctx-row ctx-stepper";

  const readout = document.createElement("span");
  readout.className = "ctx-stepper-value";

  const step = (dir: 1 | -1): void => {
    const next = Math.min(9, Math.max(1, get() + dir));
    set(next);
    sync();
  };

  const mkBtn = (text: string, dir: 1 | -1): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.title = `${label} ${dir > 0 ? "larger" : "smaller"}`;
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btn.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      e.preventDefault();
      step(dir);
    });
    return btn;
  };

  row.appendChild(mkBtn("−", -1));
  row.appendChild(readout);
  row.appendChild(mkBtn("+", 1));
  (row as HTMLElement & { _readout?: HTMLElement })._readout = readout;
  return row;
};

// Straight / smooth-bezier / orthogonal — built as tiny inline SVGs
// (mirrors align.ts's buildIcon) rather than vendoring three more
// lucide icons for a one-off glyph.
const SVG_NS = "http://www.w3.org/2000/svg";
const buildLineStyleIcon = (d: string): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);
  return svg;
};

const LINE_STYLES: ReadonlyArray<{ style: number; d: string; label: string }> = [
  { style: 1, d: "M2 14 L14 2", label: "Straight" },
  { style: 2, d: "M2 14 Q 8 2 14 14", label: "Smooth curve" },
  { style: 3, d: "M2 14 L2 8 L14 8 L14 2", label: "Orthogonal (right angles)" },
];

const buildLineStyleRow = (sync: () => void): HTMLElement => {
  const row = document.createElement("div");
  row.className = "ctx-row ctx-line-styles";
  for (const { style, d, label } of LINE_STYLES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset["style"] = String(style);
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.appendChild(buildLineStyleIcon(d));
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btn.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      e.preventDefault();
      setLineStyle(style);
      sync();
    });
    row.appendChild(btn);
  }
  return row;
};

// Shape glyphs: rectangle, circle, triangle, hexagon — built the same
// inline-SVG way as the line-style icons (kept visually consistent
// with each other rather than mixing in more vendored lucide icons).
// Persisted shape ids: 0 rect, 1 hexagon, 2 circle, 3 triangle
// (SHAPE_FOR_KEY reorders these for the keyboard's 1-4 user-facing
// slots; the touch row lists them in the same user-facing order).
const SHAPES: ReadonlyArray<{ shape: number; label: string; d: string }> = [
  { shape: 0, label: "Rectangle", d: "M2 4 L14 4 L14 12 L2 12 Z" },
  { shape: 2, label: "Circle", d: "M8 2 A6 6 0 1 1 7.99 2 Z" },
  { shape: 3, label: "Triangle", d: "M8 2 L14 14 L2 14 Z" },
  { shape: 1, label: "Hexagon", d: "M4 2.5 L12 2.5 L15 8 L12 13.5 L4 13.5 L1 8 Z" },
];

const buildShapeIcon = (d: string): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
};

// `forSelection` picks the target: true applies to every selected
// box (Alt+1..4-with-selection's touch equivalent), false sets the
// file's default shape (Alt+1..4-with-nothing-selected's equivalent).
const buildShapeRow = (forSelection: boolean, current: number, sync: () => void): HTMLElement => {
  const row = document.createElement("div");
  row.className = "ctx-row ctx-shapes";
  for (const { shape, label, d } of SHAPES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = forSelection ? label : `Default shape: ${label}`;
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("active", shape === current);
    btn.appendChild(buildShapeIcon(d));
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    btn.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (forSelection) ctxBindings!.applyShapeToSelection(shape);
      else setDefaultShape(shape);
      sync();
    });
    row.appendChild(btn);
  }
  return row;
};

const iconCursor = (): SVGSVGElement => icon("mouse-pointer");
const iconBrush = (): SVGSVGElement => icon("brush");
const iconText = (): SVGSVGElement => icon("type");
const iconLine = (): SVGSVGElement => icon("slash");

export const attachContextBar = (): void => {
  if (document.getElementById("contextBar")) return;

  const bar = document.createElement("div");
  bar.id = "contextBar";

  const modeRow = document.createElement("div");
  modeRow.className = "ctx-row ctx-modes";
  const buttons: Array<{ mode: Mode; el: HTMLButtonElement }> = [];

  const makeMode = (mode: Mode, label: string, iconEl: SVGSVGElement): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset["mode"] = mode;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.appendChild(iconEl);
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    let activated = false;
    const activate = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      if (activated) return;
      activated = true;
      setTimeout(() => { activated = false; }, 0);
      setMode(mode);
      sync();
    };
    btn.addEventListener("pointerup", activate);
    btn.addEventListener("click", activate);
    modeRow.appendChild(btn);
    buttons.push({ mode, el: btn });
  };

  makeMode("cursor", "Cursor", iconCursor());
  makeMode("brush", "Brush", iconBrush());
  makeMode("line", "Line", iconLine());
  makeMode("text", "Text", iconText());
  bar.appendChild(modeRow);

  let cluster: HTMLElement | null = null;

  const sync = (): void => {
    const m = currentMode();
    for (const { mode, el } of buttons) {
      el.classList.toggle("active", mode === m);
      el.setAttribute("aria-pressed", mode === m ? "true" : "false");
    }

    if (cluster) {
      cluster.remove();
      cluster = null;
    }

    if (m === "cursor") {
      if (!ctxBindings) return;
      const selectedBoxes = ctxBindings.currentMap().boxes.filter((b) => ctxBindings!.selected.has(b.id));
      // Mirrors keys.ts's Alt+1..4: "nothing selected" (not "nothing
      // selected THAT'S A BOX") is what flips to the default-shape
      // target, so an empty selection or a selection of only
      // texts/lines/strokes both land here.
      const forSelection = ctxBindings.selected.size > 0;
      const current = forSelection ? (selectedBoxes[0]?.shape ?? 0) : getDefaultShape();
      cluster = document.createElement("div");
      cluster.className = "ctx-cluster";
      cluster.appendChild(buildShapeRow(forSelection, current, sync));
      bar.appendChild(cluster);
      return;
    }

    cluster = document.createElement("div");
    cluster.className = "ctx-cluster";

    let paletteGetter: (() => number) | null = null;
    if (m === "text") {
      const stepper = buildStepper("Font size", getTextFont, setTextFont, sync);
      const readout = (stepper as HTMLElement & { _readout?: HTMLElement })._readout;
      if (readout) readout.textContent = String(getTextFont());
      cluster.appendChild(stepper);
      cluster.appendChild(buildPaletteRow(setTextPalette, sync));
      paletteGetter = getTextPalette;
    } else if (m === "line") {
      cluster.appendChild(buildLineStyleRow(sync));
      cluster.appendChild(buildPaletteRow(setLinePalette, sync));
      for (const el of cluster.querySelectorAll<HTMLButtonElement>(".ctx-line-styles button")) {
        el.classList.toggle("active", Number(el.dataset["style"]) === getLineStyle());
      }
      paletteGetter = getLinePalette;
    } else if (m === "brush") {
      cluster.appendChild(buildPaletteRow(setBrushPalette, sync));
      paletteGetter = getBrushPalette;
    }

    if (paletteGetter) {
      const cur = paletteGetter();
      const swatches = cluster.querySelectorAll<HTMLButtonElement>(".ctx-swatch");
      swatches.forEach((el, i) => el.classList.toggle("active", i + 1 === cur));
    }
    bar.appendChild(cluster);
  };
  syncFn = sync;
  sync();

  // Keyboard shortcuts (V / B / L / T) toggle modes by flipping body
  // class flags in brush.ts / line.ts / text-mode.ts — watch those so
  // the bar stays in sync without polling (also catches text mode's
  // self-exit after placing a text item).
  const mo = new MutationObserver(sync);
  mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  document.body.appendChild(bar);
};
