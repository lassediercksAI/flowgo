// Embed mode (?embed=1): the editor inside a short iframe on a host
// page — flowgo-map.com's landing header is the first consumer. The
// problem this module exists for: an iframe swallows wheel and touch
// events, so a full-width band in the host page's scroll path becomes
// a place where scrolling "sticks". The bridge forwards the gestures
// that mean "I'm scrolling the page" to the parent via postMessage
// and keeps the ones that mean "I'm using the editor":
//
//   forwarded to host    plain wheel; one-finger vertical swipe that
//                        starts on empty canvas
//   stay in the editor   any interaction on a box/handle/chrome,
//                        ctrl-or-cmd+wheel (zoom), two-finger
//                        gestures (pinch zoom / pan), horizontal
//                        one-finger swipes (map pan), taps and
//                        double-taps
//
// Everything binds on window in the CAPTURE phase, which runs before
// the editor's own document-level listeners — the editor modules stay
// untouched and unaware of embedding. The host listens for
// { flowgo: "embed-scroll", dy } and applies window.scrollBy.
//
// The forwarding deliberately targets any parent ("*"): dy is a
// scroll delta, not data — nothing about the map leaves the frame.

// `?embed=0` used to turn embed mode ON. The check was
// `URLSearchParams.has("embed")`, which asks whether the KEY is
// present and ignores the value entirely — so every spelling of "no"
// read as yes. Now the value decides: absent, empty, `0` and `false`
// are off, anything else is on (`?embed=1` stays the canonical form).
// This flag gates more than the scroll bridge — status.ts suppresses
// routine chatter on it — so getting "off" wrong is not cosmetic.
const embedFlag = (v: string | null): boolean => {
  if (v === null) return false;
  const s = v.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false";
};

export const EMBED_MODE: boolean =
  typeof location !== "undefined" &&
  embedFlag(new URLSearchParams(location.search).get("embed"));

// Axis-lock threshold: a one-finger swipe counts as page scroll once
// it has moved this many client px predominantly vertically. Below
// it, taps and double-taps fall through to the editor untouched.
const SWIPE_LOCK_PX = 8;

const onCanvasBackground = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target.closest(".box, .text-item, .handle, .grip, .stroke-group, .image-item")) {
    return false;
  }
  return target.closest("#bg-layer, #bg-svg, #canvas, #edges") !== null;
};

const forwardScroll = (dy: number): void => {
  window.parent.postMessage({ flowgo: "embed-scroll", dy }, "*");
};

// Returns a detach function — production never calls it (the bridge
// lives as long as the page), but tests re-attach per case and window
// outlives them.
export function attachEmbedBridge(): () => void {
  if (!EMBED_MODE || window.parent === window) return () => {};
  document.body.classList.add("embed-mode");
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof WindowEventMap>(
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    opts: AddEventListenerOptions,
  ) => {
    window.addEventListener(type, fn, opts);
    cleanups.push(() => window.removeEventListener(type, fn, opts));
  };

  on(
    "wheel",
    (e) => {
      // Modifier wheel is the deliberate zoom gesture — keep it. A
      // trackpad pinch also arrives as ctrlKey wheel, so pinch-zoom
      // keeps working inside the band.
      if (e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      // Line-mode deltas (Firefox) approximated the same way
      // mouse.ts normalizes them.
      forwardScroll(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY);
    },
    { capture: true, passive: false },
  );

  // One-finger vertical swipes that start on empty canvas scroll the
  // host page. Two-finger gestures never enter this path (the editor's
  // pinch module owns them), and a swipe that locks horizontal is
  // released to the editor as a map pan.
  let touchId: number | null = null;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let lock: "none" | "page" | "editor" = "none";

  on(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1 || !onCanvasBackground(e.target)) {
        touchId = null;
        lock = "none";
        return;
      }
      const t = e.touches[0]!;
      touchId = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
      lastY = t.clientY;
      lock = "none";
    },
    { capture: true, passive: true },
  );

  on(
    "touchmove",
    (e) => {
      if (touchId === null || e.touches.length !== 1) return;
      const t = e.touches[0]!;
      if (t.identifier !== touchId) return;
      if (lock === "none") {
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (Math.max(dx, dy) < SWIPE_LOCK_PX) return;
        lock = dy >= dx ? "page" : "editor";
      }
      if (lock !== "page") return;
      e.preventDefault();
      e.stopPropagation();
      forwardScroll(lastY - t.clientY);
      lastY = t.clientY;
    },
    { capture: true, passive: false },
  );

  const clear = () => {
    touchId = null;
    lock = "none";
  };
  on("touchend", clear, { capture: true, passive: true });
  on("touchcancel", clear, { capture: true, passive: true });
  return () => {
    for (const c of cleanups) c();
    document.body.classList.remove("embed-mode");
  };
}
