// DOM-aware adapters around the pure anchor helpers in src/graph/.
// These bridge a `(box, el)` pair into a Box2D for the pure layer,
// which doesn't know about offsetWidth/offsetHeight.
//
// Centralising them here means render code and interaction code share
// one definition; the previous inline duplicates in main.ts have been
// the source of subtle drift bugs.

import {
  handleAnchor as handleAnchorPure,
  nearestHandle as nearestHandlePure,
  rectAnchor,
} from "../index.ts";
import type { HandleCode } from "../graph/handle.ts";
import type { Box2D, Vec2 } from "../graph/types.ts";

interface BoxLike {
  readonly x: number;
  readonly y: number;
}

const boxFor = (el: HTMLElement, b: BoxLike): Box2D => ({
  x: b.x,
  y: b.y,
  width: el.offsetWidth,
  height: el.offsetHeight,
});

export const handleAnchor = (
  el: HTMLElement,
  b: BoxLike,
  code: HandleCode,
): Vec2 => handleAnchorPure(boxFor(el, b), code);

export const nearestHandle = (
  b: BoxLike,
  el: HTMLElement,
  fx: number,
  fy: number,
): HandleCode => nearestHandlePure(boxFor(el, b), [fx, fy]);

// Decide which handle on a target box would receive a connection if
// the link drag ended right now. Used by both the move handlers
// (live highlight) and the up/end handlers (final edge routing) so
// the visual cue and the actual drop are guaranteed to agree.
//
// Priority: if the cursor / finger is directly over one of the
// target's own handle dots, use that exact code. Otherwise fall
// back to whichever handle is closest to the *source* anchor — same
// logic the historical mouse onMouseUp path used.
export const pickTargetHandle = (
  targetEl: HTMLElement,
  targetBox: BoxLike,
  fromX: number,
  fromY: number,
  clientX: number,
  clientY: number,
): HandleCode => {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const el of stack) {
    const h = el as HTMLElement;
    if (h.classList?.contains("handle") && h.parentElement === targetEl) {
      const code = h.dataset["handle"];
      if (code) return code as HandleCode;
    }
  }
  return nearestHandle(targetBox, targetEl, fromX, fromY);
};

// Resolve an edge endpoint to a screen-space point. All boxes are
// rectangles now; use the named handle if stored, or fall back to the
// nearest one.
export const endpointAnchor = (
  b: BoxLike,
  el: HTMLElement,
  code: string | null | undefined,
  towardX: number,
  towardY: number,
): Vec2 => rectAnchor(boxFor(el, b), code, [towardX, towardY]);
