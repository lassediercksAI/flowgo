// Touch-only mode bar: pinned to the right edge so coarse-pointer
// users can switch between cursor / brush / line / text modes that
// desktop users hit with the V / B / L / T keys, plus a latch for the
// persistent hexagon setting (double-click spawns hexagons) that
// desktop users flip in the ⚙ settings popover. Visibility is
// controlled by CSS (`body.touch-input #modeBar`) so the bar simply
// doesn't render on fine-pointer devices.
//
// The bar reads current state from body class flags (`.brush-mode` /
// `.line-mode` / `.text-mode` / `.hex-mode`, owned by brush.ts /
// line.ts / text-mode.ts / hex.ts) and keeps its highlights in sync
// via a MutationObserver, so keyboard toggles, the settings popover,
// and button taps all land on the same source of truth. Text mode is
// single-shot (placing a text item exits it), and the observer means
// the highlight falls back to cursor automatically when that happens.
//
// Mode buttons (cursor/brush/line/text) are mutually exclusive; the
// hex latch is independent — it changes what a double-click creates,
// not which tool is active, so it can be on in any mode.

import { isBrushMode, setBrushMode } from "./brush.ts";
import { isHexMode, setHexMode } from "./hex.ts";
import { isLineMode, setLineMode } from "./line.ts";
import { isTextMode, setTextMode } from "./text-mode.ts";

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

const ns = "http://www.w3.org/2000/svg";

const svgEl = (
  size: number,
  build: (root: SVGSVGElement) => void,
): SVGSVGElement => {
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  build(svg);
  return svg;
};

// Standard arrow pointer.
const iconCursor = (): SVGSVGElement => svgEl(20, (svg) => {
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M4 3 L4 16 L8 12 L11 18 L13 17 L10 11 L16 11 Z");
  p.setAttribute("fill", "currentColor");
  p.setAttribute("stroke", "currentColor");
  svg.appendChild(p);
});

// Pencil glyph — same silhouette as the brush-mode cursor SVG.
const iconBrush = (): SVGSVGElement => svgEl(20, (svg) => {
  const body = document.createElementNS(ns, "path");
  body.setAttribute("d", "M3 17 L5 16 L14 7 L12 5 L3 14 Z");
  body.setAttribute("fill", "currentColor");
  svg.appendChild(body);
  const tip = document.createElementNS(ns, "path");
  tip.setAttribute("d", "M13 6 L16 3 L18 5 L15 8 Z");
  tip.setAttribute("fill", "#a60");
  tip.setAttribute("stroke", "currentColor");
  svg.appendChild(tip);
});

// Flat-top hexagon outline — the shape hexagon mode spawns. Vertices
// of a regular flat-top hex around (10, 10) with circumradius 7.
const iconHex = (): SVGSVGElement => svgEl(20, (svg) => {
  const p = document.createElementNS(ns, "path");
  p.setAttribute(
    "d",
    "M17 10 L13.5 16.06 L6.5 16.06 L3 10 L6.5 3.94 L13.5 3.94 Z",
  );
  svg.appendChild(p);
});

// Capital "T" glyph — text mode places a text label on double-tap.
const iconText = (): SVGSVGElement => svgEl(20, (svg) => {
  const bar = document.createElementNS(ns, "line");
  bar.setAttribute("x1", "4");  bar.setAttribute("y1", "4");
  bar.setAttribute("x2", "16"); bar.setAttribute("y2", "4");
  svg.appendChild(bar);
  const stem = document.createElementNS(ns, "line");
  stem.setAttribute("x1", "10"); stem.setAttribute("y1", "4");
  stem.setAttribute("x2", "10"); stem.setAttribute("y2", "16");
  svg.appendChild(stem);
});

// Diagonal segment with two endpoint dots.
const iconLine = (): SVGSVGElement => svgEl(20, (svg) => {
  const ln = document.createElementNS(ns, "line");
  ln.setAttribute("x1", "4");  ln.setAttribute("y1", "16");
  ln.setAttribute("x2", "16"); ln.setAttribute("y2", "4");
  svg.appendChild(ln);
  for (const [cx, cy] of [[4, 16], [16, 4]] as const) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", "2");
    c.setAttribute("fill", "currentColor");
    svg.appendChild(c);
  }
});

export const attachModeBar = (): void => {
  if (document.getElementById("modeBar")) return;

  const bar = document.createElement("div");
  bar.id = "modeBar";

  const buttons: Array<{ mode: Mode; el: HTMLButtonElement }> = [];

  const make = (mode: Mode, label: string, icon: SVGSVGElement): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset["mode"] = mode;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.appendChild(icon);
    // Don't let taps clear selection or trigger canvas gestures.
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
    // iOS Safari's synthetic click after a touch sequence is unreliable
    // when an ancestor (here: the document-level touchstart in touch.ts)
    // listens with passive: false — clicks on inner buttons sometimes
    // get suppressed. pointerup fires synchronously for both mouse and
    // touch and bypasses that race entirely.
    let activated = false;
    const activate = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      if (activated) return;
      activated = true;
      // Reset on the next tick so a held finger doesn't lock the button
      // out of subsequent taps.
      setTimeout(() => { activated = false; }, 0);
      setMode(mode);
      sync();
    };
    btn.addEventListener("pointerup", activate);
    // Fallback for browsers that don't fire pointerup (very old Safari).
    btn.addEventListener("click", activate);
    bar.appendChild(btn);
    buttons.push({ mode, el: btn });
    return btn;
  };

  make("cursor", "Cursor",  iconCursor());
  make("brush",  "Brush",   iconBrush());
  make("line",   "Line",    iconLine());
  make("text",   "Text",    iconText());

  // Hexagon latch — independent of the exclusive mode cycle above.
  // Toggles the persistent setting; highlight mirrors isHexMode().
  const hexBtn = document.createElement("button");
  hexBtn.type = "button";
  hexBtn.dataset["mode"] = "hex";
  hexBtn.title = "Double-click creates hexagons";
  hexBtn.setAttribute("aria-label", "Double-click creates hexagons");
  hexBtn.appendChild(iconHex());
  hexBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  hexBtn.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
  let hexActivated = false;
  const hexActivate = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    if (hexActivated) return;
    hexActivated = true;
    setTimeout(() => { hexActivated = false; }, 0);
    setHexMode(!isHexMode());
    sync();
  };
  hexBtn.addEventListener("pointerup", hexActivate);
  hexBtn.addEventListener("click", hexActivate);
  bar.appendChild(hexBtn);

  const sync = (): void => {
    const m = currentMode();
    for (const { mode, el } of buttons) {
      el.classList.toggle("active", mode === m);
      el.setAttribute("aria-pressed", mode === m ? "true" : "false");
    }
    hexBtn.classList.toggle("active", isHexMode());
    hexBtn.setAttribute("aria-pressed", isHexMode() ? "true" : "false");
  };
  sync();

  // Keyboard shortcuts (V / B / L / T) toggle the modes by flipping
  // body class flags in brush.ts / line.ts / text-mode.ts. Watch those
  // flags so the active highlight stays in sync without polling (this
  // also catches text mode's self-exit after placing a text item).
  const mo = new MutationObserver(sync);
  mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  document.body.appendChild(bar);
};
