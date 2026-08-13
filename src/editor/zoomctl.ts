// Bottom-left zoom control: [−] [percentage] [+]. The step buttons
// zoom anchored to the window centre (a button click has no cursor
// position worth anchoring to), and double-clicking (or double-
// tapping) the percentage resets to 100% + recenter — identical to
// Cmd/Ctrl+0.
//
// Follows the modebar pattern: the cluster is built here rather than
// in index.html, every pointer event is stopped at the buttons so
// presses never fall through to canvas gestures (a double-click on
// the percentage must not create a box underneath it), and activation
// runs on pointerup because iOS Safari's synthetic click is
// unreliable under the document-level touch handlers (see modebar.ts).

import { icon } from "./icons.ts";
import {
  MAX_SCALE,
  MIN_SCALE,
  recenter,
  resetZoom,
  viewport,
  wireViewportDisplay,
  zoomAt,
} from "./viewport.ts";

// Per-click zoom factor. Deliberately coarser than the wheel's
// per-pixel exponential — a click should feel like one visible step
// (100 → 125 → 156 → …), not a nudge.
const STEP = 1.25;

// Two activations of the percentage button within this window count
// as the double-click/double-tap that resets the view.
const DOUBLE_MS = 400;

// ── Pure helpers (exported for direct testing) ──────────────────

// Readout text + step-button disable flags for a scale. The 1e-6
// epsilon absorbs float drift from repeated multiplicative steps so
// "at the clamp" is still recognised when s is 0.5000000000000001
// rather than exactly MIN_SCALE.
export const zoomDisplay = (
  s: number,
): {
  readonly text: string;
  readonly outDisabled: boolean;
  readonly inDisabled: boolean;
} => ({
  text: `${Math.round(s * 100)}%`,
  outDisabled: s <= MIN_SCALE + 1e-6,
  inDisabled: s >= MAX_SCALE - 1e-6,
});

// Double-tap bookkeeping for the % readout: given the recorded
// previous-tap timestamp and the current one, decide whether this
// activation completes a double-tap (reset) and what to record for
// the next activation. A completed double-tap clears the record so a
// third tap inside the window starts a fresh pair instead of firing
// a second reset.
export const levelTapAdvance = (
  last: number,
  now: number,
): { readonly reset: boolean; readonly last: number } =>
  now - last < DOUBLE_MS
    ? { reset: true, last: 0 }
    : { reset: false, last: now };

const stepZoom = (factor: number): void => {
  zoomAt(
    window.innerWidth / 2,
    window.innerHeight / 2,
    viewport.s * factor,
  );
};

export const attachZoomControl = (w: {
  currentMap: () => Parameters<typeof recenter>[0];
}): void => {
  if (document.getElementById("zoomCtl")) return;

  const bar = document.createElement("div");
  bar.id = "zoomCtl";

  const make = (label: string, onActivate: () => void): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    // Keep presses out of the canvas handlers (selection clearing,
    // bg double-click box creation, touch gestures).
    for (const ev of ["mousedown", "dblclick"] as const) {
      btn.addEventListener(ev, (e) => e.stopPropagation());
    }
    btn.addEventListener("touchstart", (e) => e.stopPropagation(), {
      passive: true,
    });
    // pointerup + guarded click fallback, exactly as in modebar.ts.
    let activated = false;
    const activate = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      if (activated || btn.disabled) return;
      activated = true;
      setTimeout(() => { activated = false; }, 0);
      onActivate();
    };
    btn.addEventListener("pointerup", activate);
    btn.addEventListener("click", activate);
    bar.appendChild(btn);
    return btn;
  };

  const outBtn = make("Zoom out", () => stepZoom(1 / STEP));
  outBtn.appendChild(icon("minus", 16));

  let lastLevelTap = 0;
  const level = make("Zoom level — double-click to reset", () => {
    const tap = levelTapAdvance(lastLevelTap, performance.now());
    lastLevelTap = tap.last;
    if (tap.reset) resetZoom(w.currentMap());
  });
  level.id = "zoomLevel";

  const inBtn = make("Zoom in", () => stepZoom(STEP));
  inBtn.appendChild(icon("plus", 16));

  document.body.appendChild(bar);

  // Percentage readout + clamp feedback, driven by every viewport
  // redraw (pan included — cheap, three property writes).
  wireViewportDisplay(() => {
    const d = zoomDisplay(viewport.s);
    level.textContent = d.text;
    outBtn.disabled = d.outDisabled;
    inBtn.disabled = d.inDisabled;
  });
};
