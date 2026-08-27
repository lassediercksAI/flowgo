// Help overlay: visible/hidden state plus the wiring that opens it
// from the toolbar button and closes it on the ✕ or a backdrop tap.
// The keyboard handler in main.ts asks `isHelpOpen()` to decide whether
// Escape should close the overlay vs. clear the selection.
//
// TOUCH NOTE (brain#257). Every other chrome control in this editor
// activates on `pointerup` with a guarded `click` fallback, because
// iOS Safari's synthetic click is unreliable under the document-level
// touch listeners in touch.ts — see the header comments in zoomctl.ts
// and contextbar.ts. The help buttons were the last ones left on a
// bare `click`, so they get the same treatment here. The backdrop
// dismisses on `pointerdown` rather than `mousedown` for the same
// reason: pointer events are delivered natively for touch and don't
// depend on the mouse-event synthesis at all.

import { imagesEnabled } from "./media.ts";

const overlay = (): HTMLElement => {
  const el = document.getElementById("helpOverlay");
  if (!el) throw new Error("helpOverlay missing from DOM");
  return el;
};

export const setHelpOpen = (open: boolean): void => {
  overlay().classList.toggle("hidden", !open);
};

export const isHelpOpen = (): boolean =>
  !overlay().classList.contains("hidden");

// A pointerup and the click that may follow it are one activation, not
// two. iOS can take its time about the synthetic click, so the latch is
// held for a fixed window rather than a setTimeout(0) — long enough to
// swallow a late click, short enough that a deliberate second tap
// (open → close → open) still registers.
// NOTE (brain#294): toolbar.ts has a sibling helper of the same name
// with deliberately different semantics. This latch spans BOTH events,
// which is right for a toggle — a second activation inside the window
// would just undo the first. Up is repeatable (three fast taps must
// climb three levels), so its latch only ever suppresses the click
// that trails a pointerup, never a pointerup. Don't merge them.
const ACTIVATION_LATCH_MS = 500;

const onActivate = (el: Element, run: () => void): void => {
  // -Infinity, not 0: performance.now() is small for the first half
  // second of the page's life, and a 0 sentinel would swallow every
  // activation in that window.
  let last = Number.NEGATIVE_INFINITY;
  const fire = (e: Event): void => {
    const now = performance.now();
    if (now - last < ACTIVATION_LATCH_MS) return;
    last = now;
    e.preventDefault();
    e.stopPropagation();
    run();
  };
  el.addEventListener("pointerup", fire);
  el.addEventListener("click", fire);
};

export const attachHelpListeners = (): void => {
  const btn = document.getElementById("helpBtn");
  const close = document.getElementById("helpClose");
  if (btn) onActivate(btn, () => setHelpOpen(true));
  if (close) onActivate(close, () => setHelpOpen(false));
  overlay().addEventListener("pointerdown", (e) => {
    if (e.target === overlay()) setHelpOpen(false);
  });
  // media.ts's window.FLOWGO_IMAGES_ENABLED gate: don't advertise a
  // shortcut that's been switched off (flowgo-website's case today).
  // A one-way removal rather than a hidden-class toggle — the flag is
  // set once, before this bundle boots, and never flips back on mid
  // session.
  if (!imagesEnabled()) {
    document.getElementById("helpImagesRow")?.remove();
  }
};
