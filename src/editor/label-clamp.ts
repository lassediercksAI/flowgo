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
