// Line-clamp bookkeeping for explicitly sized boxes (the resize
// feature). A resized box has a fixed frame; its label wraps inside
// it and everything past the last full line is ellipsised. CSS alone
// can't do "clamp to whatever fits the container" — -webkit-line-clamp
// wants a line COUNT — so this helper measures the box and stamps the
// count into the `--label-clamp` custom property that the
// `.box.sized .box-label` rule consumes.
//
// Called from renderAll (when a sized box is built) and from the
// resize mover on every drag tick (cheap: two getComputedStyle reads).
// Deliberately dependency-free so both can import it without cycles.

// Hexagons: the frame is fixed (HEX_W × HEX_H) but the line budget
// still depends on the label's font size (font-2..9 scale it up).
// The label block is capped at 68% of the hex width; at that band's
// horizontal extremes the slanted edges cut the usable height to
// ~64% of the hex height (the 68%-wide inscribed rectangle of a
// flat-top hexagon). Everything past the lines that fit is
// ellipsised by the same --label-clamp CSS the sized boxes use.
const HEX_LABEL_HEIGHT_FRAC = 0.64;

export const updateHexLabelClamp = (el: HTMLElement): void => {
  const label = el.querySelector<HTMLElement>(".box-label");
  if (!label) return;
  const lineH = parseFloat(getComputedStyle(label).lineHeight);
  if (!Number.isFinite(lineH) || lineH <= 0) return;
  const avail = el.clientHeight * HEX_LABEL_HEIGHT_FRAC;
  const lines = Math.max(1, Math.floor(avail / lineH));
  el.style.setProperty("--label-clamp", String(lines));
};

export const updateSizedLabelClamp = (el: HTMLElement): void => {
  const label = el.querySelector<HTMLElement>(".box-label");
  if (!label) return;
  const boxCS = getComputedStyle(el);
  const padY =
    parseFloat(boxCS.paddingTop) + parseFloat(boxCS.paddingBottom);
  const lineH = parseFloat(getComputedStyle(label).lineHeight);
  if (!Number.isFinite(lineH) || lineH <= 0) return;
  // clientHeight = content + padding (border-box, borders excluded) —
  // subtracting the vertical padding leaves the text area.
  const avail = el.clientHeight - padY;
  const lines = Math.max(1, Math.floor(avail / lineH));
  el.style.setProperty("--label-clamp", String(lines));
};
