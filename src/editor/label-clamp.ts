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

export const updateFixedShapeLabelClamp = (
  el: HTMLElement,
  frac: number,
): void => {
  const label = el.querySelector<HTMLElement>(".box-label");
  if (!label) return;
  const lineH = parseFloat(getComputedStyle(label).lineHeight);
  if (!Number.isFinite(lineH) || lineH <= 0) return;
  const avail = el.clientHeight * frac;
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
