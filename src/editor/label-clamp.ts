// Line-clamp bookkeeping for boxes with a FIXED FRAME — resized
// rectangles (the resize feature) and the special shapes (hexagon,
// circle, triangle). Their frame can't grow to fit the label, so the
// label wraps inside it and everything past the last full line is
// ellipsised. CSS alone can't do "clamp to whatever fits the
// container" — `-webkit-line-clamp` wants a line COUNT — so this
// module works out the count and stamps it into the `--label-clamp`
// custom property the `.box.sized / .hex / .circle / .tri` label
// rules consume.
//
// ── Why this is batched (brain#258) ─────────────────────────────
// The count comes from a layout READ (the frame's clientHeight) and
// two style reads (the label's line-height, the box's vertical
// padding), and is applied as a style WRITE. Doing read→write per
// element immediately after inserting that element — which is what
// this module used to do, straight from materializeBox — is the
// textbook layout-thrash pattern: each read has to flush the style
// and layout work the insertion just invalidated, so the browser
// lays out the whole canvas once PER BOX.
//
// Measured on a 12,000-box fixture at ~4,300 visible boxes, worst
// blocked frame during a zoom step: 62 ms auto-sized vs 2,282 ms
// fixed-frame — 36.8x for maps that are otherwise identical. Every
// hexagon, circle and triangle took that path, so shaped maps capped
// out at roughly a third of the item budget everyone else got from
// the #236-#23a perf chain.
//
// The fix is read/write batching. Callers `queueLabelClamp` during
// insertion and `flushLabelClamps` once the batch is built; the flush
// does EVERY read first and only then every write, so the browser
// flushes once for the whole batch instead of once per box. The
// numbers read are exactly the numbers the per-element version read
// — a `.box` is absolutely positioned, so its frame depends on its
// own inline width/height and its own classes and never on its
// siblings — which is what makes the clamp counts, and therefore the
// rendered text, byte-identical.
//
// Two alternatives deliberately NOT taken:
//   * `canvas.measureText` — inapplicable. Nothing here measures
//     text; the budget is floor(usable height / line height).
//   * deriving the count arithmetically from w/h and font size —
//     that would drop the last flush too, but it means copying the
//     0.55em padding, the 1.2 line-height, four per-shape border
//     widths and the fixed shape sizes out of the stylesheet into
//     TypeScript, and betting that Chrome's LayoutUnit quantisation
//     of a computed line-height matches JS float math. Identical
//     output is the bar, so the geometry stays measured.
//
// The style reads ARE memoised, though — see `metricsFor`.
// Deliberately dependency-free so render.ts and movers.ts can both
// import it without cycles.

// Special shapes: the frame is fixed but the line budget still
// depends on the label's font size (font-2..9 scale it up). Each
// shape caps its label width in CSS and exposes a usable-height
// fraction here — the part of the frame the label block may fill
// before the silhouette cuts it off. Everything past the lines that
// fit is ellipsised by the same --label-clamp CSS the sized boxes
// use.
//
//   hexagon  0.64 — the 68%-wide inscribed rectangle of a flat-top
//                   hexagon (label capped at 68% width in CSS);
//   circle   0.62 — a 64%-wide chord band of the circle;
//   triangle 0.40 — the lower band where a 50%-wide block fits the
//                   narrowing silhouette (label biased low in CSS).
export const shapeLabelClampFrac = (
  shape: number | undefined,
): number | null => {
  switch (shape) {
    case 1:
      return 0.64;
    case 2:
      return 0.62;
    case 3:
      return 0.4;
    default:
      return null;
  }
};

interface Metrics {
  /** Used line-height of `.box-label`, in px. */
  readonly lineH: number;
  /** Vertical padding of the box, in px (sized rectangles only). */
  readonly padY: number;
}

// getComputedStyle is not free even against a clean style tree, and
// the old code called it TWICE PER BOX. But every rule feeding these
// two numbers — `.box`'s `padding: 0.55em 0.85em` and
// `line-height: 1.2`, the `.font-2..9` sizes, the per-shape padding
// overrides — is selected purely by class, and the only inline styles
// the render path writes are left/top/width/height and --label-clamp
// itself. Two boxes carrying the same class list therefore compute
// the same line-height and padding, always. So the reads are memoised
// on the class list, and a render of N boxes costs one
// getComputedStyle pair per DISTINCT box style (in practice one or
// two) instead of N pairs.
//
// `null` = this style has no usable line-height (jsdom, or a label
// that isn't laid out); cached too, so we don't re-probe per box.
const metricsCache = new Map<string, Metrics | null>();

// Exported for tests. The cache is valid as long as the stylesheet
// is, and the stylesheet is a single inlined <style> that never
// changes at runtime — nothing in the editor calls this.
export const resetLabelClampMetrics = (): void => metricsCache.clear();

const metricsFor = (el: HTMLElement, label: HTMLElement): Metrics | null => {
  const key = el.className;
  const hit = metricsCache.get(key);
  if (hit !== undefined) return hit;
  const lineH = parseFloat(getComputedStyle(label).lineHeight);
  let m: Metrics | null = null;
  if (Number.isFinite(lineH) && lineH > 0) {
    const boxCS = getComputedStyle(el);
    const padY =
      parseFloat(boxCS.paddingTop) + parseFloat(boxCS.paddingBottom);
    m = { lineH, padY: Number.isFinite(padY) ? padY : 0 };
  }
  metricsCache.set(key, m);
  return m;
};

interface Pending {
  readonly el: HTMLElement;
  // `null` = sized rectangle: the label owns the whole content box,
  // minus the box's own vertical padding. A special shape passes its
  // usable-height fraction instead — its padding is already baked
  // into the fraction (and into where CSS puts the label).
  readonly frac: number | null;
}

let queue: Pending[] = [];
let scheduled = false;

/**
 * Register a fixed-frame box whose label budget needs (re)computing.
 * Nothing is read or written until `flushLabelClamps`.
 *
 * A microtask flush is scheduled as a safety net, so a future caller
 * that forgets to flush still gets a correct clamp — and gets it
 * before the browser paints, so there is no frame of unclamped text.
 * The render paths flush explicitly anyway; that only makes the
 * timing deterministic (and testable synchronously under jsdom).
 */
export const queueLabelClamp = (
  el: HTMLElement,
  frac: number | null,
): void => {
  queue.push({ el, frac });
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(flushLabelClamps);
  }
};

/**
 * Apply every queued clamp: all reads, then all writes. One forced
 * style+layout flush for the whole batch instead of one per box.
 */
export const flushLabelClamps = (): void => {
  scheduled = false;
  if (queue.length === 0) return;
  const work = queue;
  queue = [];

  // ── READ PHASE ── nothing in this loop writes to the DOM, so the
  // first read pays for the flush and the rest are free. -1 marks
  // "skip" so the write phase stays branch-simple.
  const budget = new Array<number>(work.length);
  for (let i = 0; i < work.length; i++) {
    const { el, frac } = work[i]!;
    budget[i] = -1;
    // A box materialized and then removed inside the same batch (an
    // id listed twice in renderItems) would measure as a detached
    // zero-height frame; skipping keeps it out of the write phase.
    if (!el.isConnected) continue;
    const label = el.querySelector<HTMLElement>(".box-label");
    if (!label) continue;
    const m = metricsFor(el, label);
    if (!m) continue;
    // clientHeight = content + padding (border-box, borders excluded).
    // For a sized rectangle, subtracting the vertical padding leaves
    // the text area; a special shape scales the whole frame by its
    // usable fraction instead.
    const avail = frac === null
      ? el.clientHeight - m.padY
      : el.clientHeight * frac;
    budget[i] = Math.max(1, Math.floor(avail / m.lineH));
  }

  // ── WRITE PHASE ──
  for (let i = 0; i < work.length; i++) {
    const lines = budget[i]!;
    if (lines < 0) continue;
    work[i]!.el.style.setProperty("--label-clamp", String(lines));
  }
};

/**
 * Immediate single-element clamp for a sized rectangle. Used by the
 * resize mover, which rewrites one box's width/height per drag tick:
 * there is exactly one element, the write that invalidated layout is
 * the caller's own, and the result has to be on screen this frame —
 * batching has nothing to save.
 */
export const updateSizedLabelClamp = (el: HTMLElement): void => {
  queueLabelClamp(el, null);
  flushLabelClamps();
};
