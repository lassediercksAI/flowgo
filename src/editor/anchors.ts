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
import { toDataX, toDataY } from "./viewport.ts";

interface BoxLike {
  readonly x: number;
  readonly y: number;
  // Silhouette selector (0/undefined rect, 1 hexagon) — forwarded to
  // the pure layer so hexagon corners anchor at the true vertices.
  readonly shape?: number | undefined;
}

// Anything that can report a box's rendered size. A live HTMLElement
// satisfies it structurally, and so does a plain
// `{ offsetWidth, offsetHeight }` snapshot — which is what lets
// render.ts read every box element's size ONCE per pass and then run
// the anchor maths without touching the DOM again (brain#25b: the
// per-edge read/write interleave in renderEdges).
export interface ElSize {
  readonly offsetWidth: number;
  readonly offsetHeight: number;
}

// Pure bridge: a stored box position + a measured element size make
// the Box2D the src/graph/ anchor math consumes. Exported for tests —
// the width/height-from-element vs x/y-from-box split IS the contract.
export const boxFor = (el: ElSize, b: BoxLike): Box2D => ({
  x: b.x,
  y: b.y,
  width: el.offsetWidth,
  height: el.offsetHeight,
});

export const handleAnchor = (
  el: ElSize,
  b: BoxLike,
  code: HandleCode,
): Vec2 => handleAnchorPure(boxFor(el, b), code, b.shape);

export const nearestHandle = (
  b: BoxLike,
  el: ElSize,
  fx: number,
  fy: number,
): HandleCode => nearestHandlePure(boxFor(el, b), [fx, fy], b.shape);

// Decide which handle on a target box would receive a connection if
// the link drag ended right now. Used by both the move handlers
// (live highlight) and the up/end handlers (final edge routing) so
// the visual cue and the actual drop are guaranteed to agree.
//
// Priority: if the cursor / finger is directly over one of the
// target's own handle dots, use that exact code. Otherwise the
// handle whose anchor is closest to the CURSOR wins — the user aims
// the line at a handle, so the pointer is the intent signal. (An
// earlier version fell back to the handle nearest the *source*
// anchor, which systematically picked the source-facing corner —
// usually tl — no matter where on the target the user pointed.)
// Pure half of the priority rule: scan an elementsFromPoint stack for
// a handle dot that belongs to THIS target box (parentElement check —
// a neighbouring box's dot under the cursor must not hijack the drop)
// and has a code to give. Null means "no direct hit, fall back to
// geometry". Extracted so the selection rules are testable without
// stubbing document.elementsFromPoint.
export const handleCodeFromStack = (
  stack: ReadonlyArray<Element>,
  targetEl: Element,
): HandleCode | null => {
  for (const el of stack) {
    const h = el as HTMLElement;
    if (h.classList?.contains("handle") && h.parentElement === targetEl) {
      const code = h.dataset["handle"];
      if (code) return code as HandleCode;
    }
  }
  return null;
};

export const pickTargetHandle = (
  targetEl: HTMLElement,
  targetBox: BoxLike,
  clientX: number,
  clientY: number,
): HandleCode => {
  const direct = handleCodeFromStack(
    document.elementsFromPoint(clientX, clientY),
    targetEl,
  );
  if (direct) return direct;
  return nearestHandle(targetBox, targetEl, toDataX(clientX), toDataY(clientY));
};

// Resolve an edge endpoint to a screen-space point. Uses the named
// handle if stored, or falls back to the nearest one; shape-aware so
// hexagon endpoints land on the silhouette.
export const endpointAnchor = (
  b: BoxLike,
  el: ElSize,
  code: string | null | undefined,
  towardX: number,
  towardY: number,
): Vec2 => rectAnchor(boxFor(el, b), code, [towardX, towardY], b.shape);
