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
import { icon } from "./icons.ts";

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

// Lucide icons (see icons.ts): pointer for cursor mode, brush,
// slash for the line tool, type for text, hexagon for the latch.
const iconCursor = (): SVGSVGElement => icon("mouse-pointer");
const iconBrush = (): SVGSVGElement => icon("brush");
const iconHex = (): SVGSVGElement => icon("hexagon");
const iconText = (): SVGSVGElement => icon("type");
const iconLine = (): SVGSVGElement => icon("slash");

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
