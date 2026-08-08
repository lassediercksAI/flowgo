// The top toolbar's buttons: ↑ Up (one level out of the current
// submap), and the two snapshot-mode buttons beside it.
//
// TOUCH NOTE (brain#294, finishing brain#256/#257). These three were
// the last chrome controls in the editor still activating on a bare
// `click`. Everything else — zoomctl.ts, contextbar.ts, help.ts —
// moved to `pointerup` with a guarded `click` fallback, because iOS
// Safari does not reliably synthesize a click from a tap while
// touch.ts holds document-level {passive:false} touchstart/touchmove
// listeners. A control whose ONLY activation path is `click` is dead
// the moment that click doesn't arrive, and Up is the only way back
// out of a submap on a phone — so it read as "the up button does not
// work at all". Reproduced in a real browser by suppressing the tap's
// synthesized click: #helpBtn and #zoomCtl kept working, #upBtn died.
//
// WHY NOT help.ts's onActivate: that one holds a 500 ms latch across
// BOTH events, which is right for an idempotent toggle (open/close)
// but wrong here — Up is repeatable, and tapping it three times fast
// to climb three levels must climb three levels. So the latch here is
// one-directional: a pointerup always activates, and only the click
// that trails it (the same tap's echo) is swallowed. Keyboard
// activation, which produces a click and no pointerup, still works.

// How long after a pointerup a `click` is still assumed to be that
// tap's own synthesized echo rather than a fresh activation. iOS can
// take its time about the synthetic click, so this is generous; it
// only ever suppresses a click, never a pointerup, so a slow double
// tap cannot lose a level to it.
const ECHO_WINDOW_MS = 500;

/**
 * Activate `run` on a tap, a mouse click, or a keyboard press, exactly
 * once per user action, without depending on the browser synthesizing
 * a click from a touch.
 */
const onActivate = (el: Element, run: () => void): void => {
  // -Infinity, not 0: performance.now() is small for the first half
  // second of the page's life, and a 0 sentinel would make the very
  // first click look like an echo (brain#257's latch hit this).
  let lastPointerUp = Number.NEGATIVE_INFINITY;
  el.addEventListener("pointerup", (e) => {
    lastPointerUp = performance.now();
    e.preventDefault();
    e.stopPropagation();
    run();
  });
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (performance.now() - lastPointerUp < ECHO_WINDOW_MS) return;
    run();
  });
};

export interface ToolbarBindings {
  readonly goUp: () => void;
  readonly downloadFlowgo: () => void;
  readonly reshare: () => void;
}

/**
 * Wire the toolbar's buttons. Missing buttons are skipped rather than
 * thrown on: downstream embedders ship their own shell around the same
 * modules, and a bootstrap that dies on a absent button takes every
 * later listener in main.ts down with it.
 */
export const attachToolbarButtons = (b: ToolbarBindings): void => {
  const wire = (id: string, run: () => void): void => {
    const el = document.getElementById(id);
    if (el) onActivate(el, run);
  };
  wire("upBtn", b.goUp);
  wire("downloadBtn", b.downloadFlowgo);
  wire("reshareBtn", b.reshare);
};
