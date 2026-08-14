// Inline label editing for boxes, text items and edge labels. Owns
// the `editing` flag (it's the gate every keyboard handler in main.ts
// checks before firing a shortcut), and handles the contenteditable
// lifecycle including the cancel-deletes rollback for boxes spawned
// with `Enter` editing on creation.
//
// One lifecycle (beginInlineEdit) with three flavours, so
// Enter-commits / Escape-reverts / blur-commits and the
// persistence.ts dirty-tracking behave identically wherever you type:
//   • text items edit their own textContent;
//   • boxes wrap their label in a `.box-label` span and read back via
//     el.innerText to capture pasted content the browser sometimes
//     lands as siblings of that span;
//   • edges edit the `.edge-label` div the renderer parks at the edge
//     midpoint, and an empty commit REMOVES the label rather than
//     being ignored (an edge with no label is a normal edge; a box
//     with no label is not a normal box).

import { MAX_LABEL_LEN, normalizeLabel } from "../graph/label.ts";
import { mutatedBox, mutatedDoc, mutatedEdge, mutatedText } from "./mutations.ts";

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
}

interface TextLike {
  id: string;
  label: string;
  x: number;
  y: number;
}

interface EditBindings {
  readonly canvas: HTMLElement;
  readonly getCurrentMap: () => {
    boxes: BoxLike[];
    edges: { from: string; to: string }[];
  };
  readonly setCurrentMap: (m: ReturnType<EditBindings["getCurrentMap"]>) => void;
  readonly getCurrentPath: () => string;
  readonly getGraph: () => { maps: { path: string }[] };
  readonly setGraph: (g: { maps: { path: string }[] }) => void;
  readonly ensureMap: (path: string) => ReturnType<EditBindings["getCurrentMap"]>;
  readonly selected: Set<string>;
  readonly renderAll: () => void;
  /** Incremental single-item rebuild (render.ts renderItems, #238) —
   *  used on edit commit so ending a label edit touches one box, not
   *  the whole canvas. */
  readonly renderItem: (id: string) => void;
  /** Refresh the edge-label layer (render.ts renderEdgeLabels) after
   *  an edge label was committed or removed. */
  readonly renderEdgeLabels: () => void;
  readonly setStatus: (s: string) => void;
}

let bindings: EditBindings | null = null;
const must = (): EditBindings => {
  if (!bindings) throw new Error("edit: wireEdit() not called");
  return bindings;
};

export const wireEdit = (b: EditBindings): void => {
  bindings = b;
};

let editing: HTMLElement | null = null;
export const isEditing = (): boolean => editing !== null;

// Id of the box/text currently being edited, if any. Viewport culling
// (#23a) exempts it from removal: this module owns a live
// contenteditable on that element, and destroying it mid-edit (e.g. a
// wheel-pan while typing) would strand the blur/keydown lifecycle.
export const editingId = (): string | null =>
  editing?.dataset?.["id"] ?? null;

// readEditableText reads the current contenteditable contents preserving
// Shift+Enter line breaks. innerText is the right tool here: it walks
// the rendered text tree and emits `\n` for `<br>` and block boundaries
// the browser inserts on Shift+Enter (whereas textContent would drop
// them silently and we'd lose every break the user typed).
const readEditableText = (el: HTMLElement): string => {
  const t = el.innerText ?? el.textContent ?? "";
  // Some browsers emit a stray trailing newline from a final `<br>` the
  // contenteditable inserts as a caret anchor — normalizeLabel trims it
  // anyway, but we route everything through it for consistency.
  return normalizeLabel(t, { maxLength: MAX_LABEL_LEN }).label;
};

interface InlineEditSpec {
  /** Element that becomes contenteditable and takes focus. */
  readonly host: HTMLElement;
  /** Element whose contents the caret selects (defaults to host). */
  readonly caretTarget?: HTMLElement;
  /** Write the current value into the DOM before focusing. */
  readonly seed: () => void;
  /** End of life. `commit` is false only for Escape. */
  readonly done: (commit: boolean) => void;
}

// The live editor's teardown, exposed so a renderer that is about to
// destroy the element underneath one can end it cleanly first.
// Without it, removing a focused contenteditable leaves `editing` set
// forever (Chrome fires no blur for a node that was detached), which
// locks out every keyboard shortcut in the app.
let activeFinish: ((commit: boolean) => void) | null = null;

// Commit the in-flight edge-label edit, if any. Called by render.ts
// before a full edge rebuild. Box/text edits are deliberately not
// covered: their elements survive the edge paths untouched.
export const commitEdgeLabelEdit = (): void => {
  if (edgeBeingEdited) activeFinish?.(true);
};

// The one contenteditable lifecycle every inline editor runs on:
// claim the `editing` flag, seed + select the text, then commit on
// blur / bare Enter and revert on Escape (Shift+Enter falls through
// to the browser so it inserts a line break, which innerText reads
// back). Every flavour tears down in the same order — listeners off,
// contenteditable off, flag cleared — BEFORE its own `done` body runs,
// so a re-render triggered from there can't find a half-lived editor.
const beginInlineEdit = (spec: InlineEditSpec): void => {
  if (editing) return;
  const { host } = spec;
  editing = host;
  // setAttribute rather than the contentEditable IDL property: they
  // are equivalent in a browser (the property reflects the attribute,
  // and every CSS rule / focusability check reads the attribute), but
  // jsdom implements only the attribute — so this is what makes the
  // editor's lifecycle testable at all.
  host.setAttribute("contenteditable", "true");
  spec.seed();
  host.focus();
  const range = document.createRange();
  range.selectNodeContents(spec.caretTarget ?? host);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  const finish = (commit: boolean): void => {
    host.removeEventListener("blur", onBlur);
    host.removeEventListener("keydown", onKey);
    host.setAttribute("contenteditable", "false");
    editing = null;
    activeFinish = null;
    spec.done(commit);
  };
  activeFinish = finish;
  const onBlur = (): void => finish(true);
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      host.blur();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
    ev.stopPropagation();
  };
  host.addEventListener("blur", onBlur);
  host.addEventListener("keydown", onKey);
};

export const startTextEdit = (el: HTMLElement, t: TextLike): void => {
  beginInlineEdit({
    host: el,
    seed: () => {
      el.textContent = t.label;
    },
    done: (commit) => {
      const newLabel = readEditableText(el);
      if (commit && newLabel && newLabel !== t.label) {
        t.label = newLabel;
        mutatedText();
      }
      el.textContent = t.label;
    },
  });
};

interface EdgeLike {
  from: string;
  to: string;
  label?: string | undefined;
}

// The edge whose label is being edited right now, or null. Viewport
// culling and the edge re-route paths in render.ts consult this for
// the same reason editingId() exists for boxes: this module owns a
// live contenteditable on that element, and destroying it mid-edit
// (a wheel-pan while typing, an endpoint drag) would strand the
// blur/keydown lifecycle with `editing` still set — which locks out
// every keyboard shortcut in the app.
let edgeBeingEdited: EdgeLike | null = null;
export const editingEdge = (): EdgeLike | null => edgeBeingEdited;

// Inline edit of an edge's midpoint label (brain#266). `el` is the
// `.edge-label` div the renderer parks at the edge midpoint; the
// renderer also created it for an unlabelled edge on demand, so this
// function never has to know whether the label already existed.
//
// The one deliberate difference from boxes and texts: an empty commit
// REMOVES the label (the field goes back to undefined and the element
// disappears on the next render) instead of being silently dropped.
// That's how a user un-labels an edge — the card's "an empty result
// removes the label".
export const startEdgeLabelEdit = (el: HTMLElement, e: EdgeLike): void => {
  const before = e.label ?? "";
  beginInlineEdit({
    host: el,
    seed: () => {
      // Set inside seed(), not before the call: beginInlineEdit bails
      // out when another editor already holds the flag, and a ref set
      // outside would then leak and exempt an edge nobody is editing.
      edgeBeingEdited = e;
      el.textContent = before;
    },
    done: (commit) => {
      edgeBeingEdited = null;
      const next = commit ? readEditableText(el) : before;
      if (next !== before) {
        if (next === "") delete e.label;
        else e.label = next;
        mutatedEdge();
      }
      // Re-render through the renderer rather than patching the
      // element here: an emptied label has no element at all, and the
      // midpoint may need re-measuring if the commit changed nothing
      // visible. renderEdgeLabels is a coordinate/text rewrite, not a
      // rebuild, so this is cheap.
      must().renderEdgeLabels();
    },
  });
};

export interface BoxEditOptions {
  readonly cancelDeletes?: boolean;
}

// Pure halves of the cancel-deletes rollback, extracted so the path
// arithmetic is testable without a DOM. A box on the current map owns
// the sub-map at `<currentPath>/<id>` ("/" is the one path that must
// not double its slash).
export const spawnedBoxMapPath = (currentPath: string, id: string): string =>
  currentPath === "/" ? "/" + id : currentPath + "/" + id;

// Drop the removed box's own sub-map and every map nested under it —
// prefix-matched on "<path>/" so removing "/b1" leaves "/b10" alone.
export const pruneMapsUnder = <M extends { path: string }>(
  maps: M[],
  removedPath: string,
): M[] =>
  maps.filter(
    (m) => m.path !== removedPath && !m.path.startsWith(removedPath + "/"),
  );

export const startEdit = (
  el: HTMLElement,
  b: BoxLike,
  opts?: BoxEditOptions,
): void => startEditAttempt(el, b, opts, false);

// `isRetry` bounds the missing-label recovery to ONE renderAll: if
// the REBUILT element still lacks its .box-label span, the renderer
// itself is emitting broken boxes and retrying again would recurse on
// the same broken output forever. Log loudly and give up instead —
// `editing` stays unclaimed, so keyboard shortcuts keep working.
const startEditAttempt = (
  el: HTMLElement,
  b: BoxLike,
  opts: BoxEditOptions | undefined,
  isRetry: boolean,
): void => {
  if (editing) return;
  const cancelDeletes = opts?.cancelDeletes ?? false;
  const labelEl = el.querySelector<HTMLElement>(".box-label");
  if (!labelEl) {
    if (isRetry) {
      console.error(
        `edit: box "${b.id}" still has no .box-label after renderAll — giving up on the edit`,
      );
      return;
    }
    // Defensive: if the label span is missing for any reason, rebuild
    // the box from state and retry once. Beats wedging `editing` to a
    // stale element and locking out every keyboard shortcut.
    must().renderAll();
    const fresh = must().canvas.querySelector<HTMLElement>(
      `.box[data-id="${b.id}"]`,
    );
    if (fresh) startEditAttempt(fresh, b, opts, true);
    return;
  }
  beginInlineEdit({
    host: el,
    caretTarget: labelEl,
    seed: () => {
      labelEl.textContent = b.label;
    },
    done: (commit) => finishBoxEdit(el, b, cancelDeletes, commit),
  });
};

const finishBoxEdit = (
  el: HTMLElement,
  b: BoxLike,
  cancelDeletes: boolean,
  commit: boolean,
): void => {
  {
    // Read from el, not labelEl: contenteditable can land pasted
    // text in sibling text nodes / divs directly under el (outside
    // the span). The SVG polygon and handle divs contribute no text
    // content, so el.innerText is just the label across whichever
    // children the browser used — and innerText preserves Shift+Enter
    // breaks that textContent would silently drop.
    const before = el.innerText ?? el.textContent ?? "";
    const norm = normalizeLabel(before, { maxLength: MAX_LABEL_LEN });
    if (norm.truncated) {
      must().setStatus("label truncated to " + MAX_LABEL_LEN + " characters");
    }
    const newLabel = norm.label;
    if (!commit && cancelDeletes) {
      const w = must();
      // Roll back: drop the just-spawned box and any of its edges.
      const map = w.getCurrentMap();
      map.boxes = map.boxes.filter((x) => x.id !== b.id);
      map.edges = map.edges.filter(
        (e) => e.from !== b.id && e.to !== b.id,
      );
      const cur = w.getCurrentPath();
      const removedPath = spawnedBoxMapPath(cur, b.id);
      const g = w.getGraph();
      g.maps = pruneMapsUnder(g.maps, removedPath);
      w.setGraph(g);
      w.setCurrentMap(w.ensureMap(cur));
      w.selected.delete(b.id);
      mutatedDoc();
      // Only the spawned box (and its edges) went away — the
      // incremental path removes exactly those elements (#238).
      w.renderItem(b.id);
      w.setStatus("cancelled");
      return;
    }
    if (commit && newLabel && newLabel !== b.label) {
      b.label = newLabel;
      mutatedBox();
    }
    // Rebuild the affected box from state. Trying to surgically
    // pluck out only the stray nodes the contenteditable inserted
    // is brittle (the browser sometimes wraps the label span in a
    // div, and a direct-child sweep then deletes the wrapper *and*
    // the span). renderItem recreates this one box's element whole
    // from state (#238) — same guarantee a full renderAll gave,
    // minus the canvas-wide churn — and re-routes its incident
    // edges (a longer label can change the box's size).
    must().renderItem(b.id);
  }
};
