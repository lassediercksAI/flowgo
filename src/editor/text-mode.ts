// Text mode: T arms it, the cursor switches to the standard I-beam
// (CSS on `body.text-mode` in index.html), and a single click (or
// touch tap) on empty canvas places a free-floating text item there
// and immediately enters inline label editing (createTextAt in
// factories.ts).
//
// Unlike line mode — which stays on so the user can chain segments —
// text mode is single-shot: placing a text item exits the mode, so
// one T press yields one text label and stray double-clicks afterwards
// go back to spawning boxes. Pressing T again (or the mode-bar button)
// re-arms it. T, V and Escape all exit without placing.
//
// This is a transient tool mode like brush/line, NOT a persistent
// setting like the hexagon preference in hex.ts — nothing is stored.
// keys.ts owns the T/V/Escape wiring, mouse.ts / touch.ts consult
// `isTextMode()` on the bg mousedown / tap paths, and contextbar.ts
// exposes it to touch users in the exclusive mode cycle.

interface TextModeBindings {
  readonly setStatus: (s: string) => void;
}

let bindings: TextModeBindings | null = null;
const must = (): TextModeBindings => {
  if (!bindings) throw new Error("text-mode: wireTextMode() not called");
  return bindings;
};

export const wireTextMode = (b: TextModeBindings): void => {
  bindings = b;
};

let textMode = false;

export const isTextMode = (): boolean => textMode;

export const setTextMode = (on: boolean): void => {
  if (textMode === on) return;
  textMode = on;
  document.body.classList.toggle("text-mode", textMode);
  must().setStatus(
    textMode
      ? "text mode — click to place text · T or Escape to exit"
      : "select mode",
  );
};

// Pending style for the NEXT placed text item — mirrors brush.ts's
// palette (set once, applied to every subsequent creation until
// changed). Surfaced in the touch context bar (contextbar.ts) so
// coarse-pointer users can set size/colour before placing text, the
// same way keyboard users pre-arm nothing and just restyle after
// (font/palette here are consumed once at creation, then the usual
// select + +/- flow takes over).
let pendingPalette = 1;
let pendingFont = 1;

export const getTextPalette = (): number => pendingPalette;
export const setTextPalette = (p: number): void => {
  if (p < 1 || p > 9) return;
  pendingPalette = p;
};

export const getTextFont = (): number => pendingFont;
export const setTextFont = (f: number): void => {
  if (f < 1 || f > 9) return;
  pendingFont = f;
};
