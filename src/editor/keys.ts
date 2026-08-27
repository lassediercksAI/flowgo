// Document-level keydown handler. Owns the entire shortcut surface:
// undo/redo, select-all, copy/cut/paste, T/L/B/V mode toggles, palette
// (1-9 absolute, +/- step with wrap), font-size (Shift+1-9 absolute,
// Shift+/- step with wrap), Escape, Delete.
//
// Every shortcut bails when an inline label edit is in progress
// (isEditing()) so typing into a contenteditable doesn't trigger
// editor commands. Help-overlay Escape is handled before that check
// so the user can always close the help.

import { isHelpOpen, setHelpOpen } from "./help.ts";
import { isEditing, startEdit, startTextEdit } from "./edit.ts";
import {
  mutatedBox,
  mutatedCurrentMap,
  mutatedEdge,
} from "./mutations.ts";
import { undo, redo } from "./persistence.ts";
import {
  isBrushMode,
  setBrushMode,
  setBrushPalette,
  startStroke as _startStroke,
} from "./brush.ts";
import {
  copySelection,
  cutSelection,
} from "./clipboard.ts";
import {
  deleteSelection,
} from "./factories.ts";
import {
  cancelPendingLine,
  isDrawingLine,
  isLineMode,
  setLineMode,
} from "./line.ts";
import { isTextMode, setTextMode } from "./text-mode.ts";
import {
  applyClasses,
  renderAll,
  renderEdges,
  renderItems,
} from "./render.ts";
import { resetZoom } from "./viewport.ts";
import { clearBoxResize, resizingBoxId, toggleBoxResize } from "./resize.ts";
import { SHAPE_FOR_KEY, SHAPE_HEX, SHAPE_NAMES } from "../graph/shape.ts";
import { setDefaultShape } from "./default-shape.ts";
import { settleHexBoxes } from "./hex.ts";

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
  anchor?: boolean;
  w?: number;
  h?: number;
  shape?: number;
}

interface TextLike {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
}

interface LineLike {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
  palette?: number;
  style?: number;
}

interface StrokeLike {
  id: string;
  palette?: number;
}

interface ImageLike {
  id: string;
}

interface EdgeLike {
  from: string;
  to: string;
  palette?: number;
}

interface CurrentMap {
  boxes: BoxLike[];
  edges: EdgeLike[];
  texts: TextLike[];
  lines: LineLike[];
  strokes?: StrokeLike[];
  images?: ImageLike[];
}

interface KeysBindings {
  readonly canvas: HTMLElement;
  readonly ghostLine: SVGLineElement;
  readonly currentMap: () => CurrentMap;
  readonly findTextById: (id: string) => TextLike | undefined;
  readonly selected: Set<string>;
  readonly selectedEdge: () => EdgeLike | null;
  readonly setSelectedEdge: (e: EdgeLike | null) => void;
  readonly link: () => { handleEl: HTMLElement } | null;
  readonly clearLink: () => void;
  readonly setDropTargetId: (id: string | null) => void;
  readonly setDropTargetHandle: (h: string | null) => void;
  readonly clearProximity: () => void;
  readonly setStatus: (s: string) => void;
}

let bindings: KeysBindings | null = null;
const must = (): KeysBindings => {
  if (!bindings) throw new Error("keys: wireKeys() not called");
  return bindings;
};

export const wireKeys = (b: KeysBindings): void => {
  bindings = b;
};

// Step palette/font on every selected target by ±1 with wrap-around
// (1↔9). Each item moves independently, so a mixed selection keeps
// its relative differences. Value 1 is stored as the absent property
// to match the file format's default placeholder.
// Exported for direct testing — pure step/wrap helper.
export const stepValue = (cur: number | undefined, dir: 1 | -1): number => {
  const c = cur && cur >= 1 && cur <= 9 ? cur : 1;
  return ((c - 1 + dir + 9) % 9) + 1;
};

// Mutate a palette-bearing target in place. `1` clears the property to
// match the file-format convention that 1 is the default placeholder.
const setPaletteOn = (
  target: { palette?: number },
  next: number,
): boolean => {
  if (next === 1) {
    if (target.palette) {
      delete target.palette;
      return true;
    }
    return false;
  }
  if (target.palette === next) return false;
  target.palette = next;
  return true;
};

// Resolve a selection id to whichever element type owns it. Edges are
// handled separately because they live in a single-selection slot, not
// the multi-id Set.
const findPaletteTarget = (id: string): { palette?: number } | undefined => {
  const w = must();
  const map = w.currentMap();
  return (
    map.boxes.find((x) => x.id === id) ||
    w.findTextById(id) ||
    map.lines.find((x) => x.id === id) ||
    (map.strokes ?? []).find((x) => x.id === id)
  );
};

const hasAnySelection = (): boolean => {
  const w = must();
  return w.selected.size > 0 || w.selectedEdge() !== null;
};

const stepPalette = (dir: 1 | -1): boolean => {
  const w = must();
  if (!hasAnySelection()) return false;
  let changed = false;
  for (const id of w.selected) {
    const target = findPaletteTarget(id);
    if (!target) continue;
    if (setPaletteOn(target, stepValue(target.palette, dir))) changed = true;
  }
  const edge = w.selectedEdge();
  if (edge && setPaletteOn(edge, stepValue(edge.palette, dir))) changed = true;
  return changed;
};

const stepFont = (dir: 1 | -1): boolean => {
  const w = must();
  if (w.selected.size === 0) return false;
  const map = w.currentMap();
  let changed = false;
  for (const id of w.selected) {
    const target =
      map.boxes.find((x) => x.id === id) || w.findTextById(id);
    if (!target) continue;
    const next = stepValue(target.font, dir);
    if (next === 1) {
      if (target.font) {
        delete target.font;
        changed = true;
      }
    } else if (target.font !== next) {
      target.font = next;
      changed = true;
    }
  }
  return changed;
};

// Toggle the anchor flag on the (single) selected box. Anchor is a
// per-map singleton — turning it on clears the flag from any other
// box on the same map, so the recenter target is unambiguous.
const toggleAnchor = (): void => {
  const w = must();
  if (w.selected.size !== 1) {
    w.setStatus("anchor needs exactly one selected node");
    return;
  }
  const id = w.selected.values().next().value as string;
  const map = w.currentMap();
  const target = map.boxes.find((b) => b.id === id);
  if (!target) {
    w.setStatus("anchor only applies to nodes");
    return;
  }
  const turningOn = !target.anchor;
  for (const b of map.boxes) {
    if (b.anchor) delete b.anchor;
  }
  if (turningOn) target.anchor = true;
  mutatedBox();
  renderAll();
  w.setStatus(turningOn ? "anchored " + id : "anchor cleared");
};

const applyPalette = (palette: number): boolean => {
  const w = must();
  if (!hasAnySelection()) return false;
  let changed = false;
  for (const id of w.selected) {
    const target = findPaletteTarget(id);
    if (!target) continue;
    if (setPaletteOn(target, palette)) changed = true;
  }
  const edge = w.selectedEdge();
  if (edge && setPaletteOn(edge, palette)) changed = true;
  return changed;
};

// Recolour JUST the selected edge, self-contained (mutate + persist +
// rebuild), unlike applyPalette above which only mutates and leaves
// mutatedCurrentMap()/render to its keydown call site because it may
// have touched a whole mixed selection in one keypress. contextbar.ts's
// touch palette row has exactly one target — the single-valued
// selectedEdge() slot — so it gets its own self-contained setter here
// (exported and passed through as a bound function, same as
// applyShapeToSelection, so contextbar.ts never has to import this
// module directly and close the render.ts <-> contextbar.ts cycle
// described in contextbar.ts's ContextBarBindings comment).
export const setEdgePalette = (palette: number): boolean => {
  const w = must();
  const edge = w.selectedEdge();
  if (!edge) return false;
  if (!setPaletteOn(edge, palette)) return false;
  mutatedEdge();
  // A palette change bakes into the edge label's class at element
  // creation (makeEdgeLabelEl) — only a full renderEdges() picks that
  // up, applyClasses() is selection-only (see render.ts's applyClasses
  // vs renderEdges split, and the Delete-key branch below for the same
  // rule applied to removal).
  renderEdges();
  return true;
};

// Remove the selected edge. Factored out of the Delete/Backspace
// branch below so it and contextbar.ts's touch delete button
// (wired through main.ts, same reasoning as setEdgePalette above)
// share one splice/clear/persist/rebuild/status sequence instead of
// two copies of it.
export const deleteSelectedEdge = (): boolean => {
  const w = must();
  const edge = w.selectedEdge();
  if (!edge) return false;
  const map = w.currentMap();
  const idx = map.edges.indexOf(edge);
  if (idx >= 0) map.edges.splice(idx, 1);
  w.setSelectedEdge(null);
  mutatedEdge();
  renderEdges();
  w.setStatus("edge removed");
  return true;
};

const applyFont = (font: number): boolean => {
  const w = must();
  if (w.selected.size === 0) return false;
  const map = w.currentMap();
  let changed = false;
  for (const id of w.selected) {
    const target =
      map.boxes.find((x) => x.id === id) || w.findTextById(id);
    if (!target) continue;
    if (font === 1) {
      if (target.font) {
        delete target.font;
        changed = true;
      }
    } else if (target.font !== font) {
      target.font = font;
      changed = true;
    }
  }
  return changed;
};

// Line style on selected lines: 1 = straight (default, cleared from
// the data), 2 = curves, 3 = orthogonal elbows. Reuses the same
// Shift+digit key surface as font size — a mixed selection of boxes
// and lines applies font to the boxes and style to the lines from a
// single keypress.
const applyLineStyle = (style: number): boolean => {
  const w = must();
  if (w.selected.size === 0) return false;
  const map = w.currentMap();
  let changed = false;
  for (const id of w.selected) {
    const line = map.lines.find((x) => x.id === id);
    if (!line) continue;
    if (style === 1) {
      if (line.style) {
        delete line.style;
        changed = true;
      }
    } else if (line.style !== style) {
      line.style = style;
      changed = true;
    }
  }
  return changed;
};

// Set every selected box's shape (0 rect, 1 hex, 2 circle, 3
// triangle — persisted ids, see SHAPE_FOR_KEY for the user-facing key
// order). Self-contained: mutates, settles the hex lattice, clears
// any in-progress resize, triggers a render, and reports status —
// callers (the Alt+1-4 keydown handler, contextbar.ts's touch shape
// row) don't need to know any of that. Becoming a special shape drops
// any pinned size (fixed footprint); becoming a hexagon settles the
// lattice so the no-overlap invariant holds immediately. Non-boxes in
// the selection are skipped, same as the palette-key precedent.
export const applyShapeToSelection = (shape: number): boolean => {
  const w = must();
  const map = w.currentMap();
  let changed = false;
  let anyHex = false;
  for (const id of w.selected) {
    const box = map.boxes.find((b) => b.id === id);
    if (!box) continue;
    if ((box.shape ?? 0) === shape) continue;
    if (shape === 0) delete box.shape;
    else box.shape = shape;
    if (shape !== 0) {
      delete box.w;
      delete box.h;
    }
    if (shape === SHAPE_HEX) anyHex = true;
    changed = true;
  }
  if (changed) {
    // Hex settling can shove OTHER boxes onto free lattice cells, so
    // a settle that moved anything falls back to the full rebuild;
    // otherwise only the selected boxes changed shape (#238).
    const settled = anyHex ? settleHexBoxes(map.boxes) : false;
    clearBoxResize();
    mutatedCurrentMap();
    if (settled) renderAll();
    else renderItems(w.selected);
    w.setStatus("shape: " + (SHAPE_NAMES[shape] ?? "rectangle"));
  }
  return changed;
};

export const attachKeyboardListener = (): void => {
  document.addEventListener("keydown", (e) => {
    const w = must();
    if (e.key === "Escape" && isHelpOpen()) {
      setHelpOpen(false);
      return;
    }
    if (isEditing()) return;

    // Cmd / Ctrl shortcuts
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && !e.altKey && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redo();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      const map = w.currentMap();
      w.selected.clear();
      // ALL five selectable kinds (brain#2e5). Strokes and images used
      // to be omitted, which meant a brush- or image-heavy map could
      // not be selected from the keyboard at all — and it made
      // select-all the only bulk operation that didn't cover the whole
      // document: delete (factories.deleteSelection), copy/cut/paste
      // (clipboard.ts), clone (clone.ts) and the marquee (mouse.ts)
      // each handle boxes, texts, lines, strokes and images.
      //
      // The marquee's "background ink" priority — lines and strokes
      // join only when the band caught nothing solid — deliberately
      // does NOT apply here. That rule disambiguates a sloppy drag; a
      // select-all has nothing to disambiguate, and it already swept
      // up lines, which are background ink by the same definition.
      //
      // Edges stay out because they cannot be multi-selected: edge
      // selection is the single-valued selectedEdge() slot, not the
      // id-keyed `selected` set. Selecting everything therefore clears
      // it, as before.
      for (const b of map.boxes) w.selected.add(b.id);
      for (const t of map.texts ?? []) w.selected.add(t.id);
      for (const l of map.lines ?? []) w.selected.add(l.id);
      for (const s of map.strokes ?? []) w.selected.add(s.id);
      for (const img of map.images ?? []) w.selected.add(img.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
      w.setStatus("selected " + w.selected.size + " items");
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && (e.key === "c" || e.key === "C")) {
      // Let the browser handle text-copy when there's a real text selection.
      if (window.getSelection && String(window.getSelection())) return;
      e.preventDefault();
      if (copySelection()) w.setStatus("copied " + w.selected.size + " items");
      else w.setStatus("nothing to copy");
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && (e.key === "x" || e.key === "X")) {
      e.preventDefault();
      cutSelection();
      return;
    }
    // Cmd/Ctrl + V is intentionally NOT handled here. Calling
    // preventDefault() on the keydown would suppress the browser's
    // native `paste` event, which is the only way to read an image off
    // the OS clipboard. Paste is handled in media.ts's document-level
    // `paste` listener, which inserts a clipboard image when present
    // and otherwise falls back to the internal buffer (pasteSelection).

    // Cmd/Ctrl + 0 → reset zoom to 100% and recenter on the anchor.
    // Mirrors the browser-zoom shortcut for "back to default view"
    // but operates on the canvas viewport. resetZoom's recenter()
    // prioritises the anchor box → b1 → bbox of all content, so the
    // same heuristic that picks the load-time camera also drives the
    // reset. Shared with the zoom control's double-click.
    if (mod && !e.altKey && !e.shiftKey && e.key === "0") {
      e.preventDefault();
      resetZoom(w.currentMap());
      return;
    }

    // Single-letter shortcuts. The transient tool modes (text / line /
    // brush) are mutually exclusive — arming one disarms the others so
    // the cursor and the bg-click behaviour always agree on a single
    // active tool.
    if (!mod && !e.altKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      const on = !isTextMode();
      if (on) {
        setBrushMode(false);
        setLineMode(false);
      }
      setTextMode(on);
      return;
    }
    if (!mod && !e.altKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      const on = !isLineMode();
      if (on) {
        setBrushMode(false);
        setTextMode(false);
      }
      setLineMode(on);
      return;
    }
    if (!mod && !e.altKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      setLineMode(false);
      setTextMode(false);
      setBrushMode(true);
      return;
    }
    // V exits the transient tool modes (brush / line / text). The
    // hexagon preference is deliberately NOT touched here — it's a
    // persistent setting (⚙ popover / mode-bar latch), not a tool mode.
    if (!mod && !e.altKey && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      setBrushMode(false);
      setLineMode(false);
      setTextMode(false);
      return;
    }
    if (!mod && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      toggleAnchor();
      return;
    }

    // E — toggle resize mode on the single selected box (grips appear;
    // drag a corner to resize). Shift+E resets the box to auto-size.
    if (!mod && !e.altKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      if (w.selected.size !== 1) {
        w.setStatus("resize needs exactly one selected node");
        return;
      }
      const id = w.selected.values().next().value as string;
      const box = w.currentMap().boxes.find((b) => b.id === id);
      if (!box) {
        w.setStatus("resize only applies to nodes");
        return;
      }
      // Special shapes are uniform by contract — hexagons because the
      // lattice snap math depends on every hex sharing the fixed
      // size, circles and triangles by design — so resize (and
      // auto-size reset) is refused outright.
      if (box.shape) {
        w.setStatus("this shape has a fixed size and can't be resized");
        return;
      }
      if (e.shiftKey) {
        // Back to auto-size: drop the explicit dims and re-render so
        // the box snaps to hugging its label again.
        if (box.w !== undefined || box.h !== undefined) {
          delete box.w;
          delete box.h;
          clearBoxResize();
          mutatedBox();
          renderItems([id]);
          w.setStatus("auto-size restored for " + id);
        }
        return;
      }
      const on = toggleBoxResize(id);
      applyClasses();
      w.setStatus(
        on
          ? "resize mode — drag a corner grip; E or Escape to finish"
          : "resize mode off",
      );
      return;
    }

    // Shape keys (Alt/⌥ + 1-4): set every selected box's shape, or (with
    // nothing selected, in plain cursor mode) the file's default shape.
    // e.code because Alt+digit types symbols on macOS layouts.
    if (!mod && e.altKey && !e.shiftKey && /^Digit[1-4]$/.test(e.code)) {
      const shape = SHAPE_FOR_KEY[parseInt(e.code.slice(5), 10)]!;
      if (w.selected.size === 0) {
        if (!isBrushMode() && !isLineMode() && !isTextMode()) {
          e.preventDefault();
          setDefaultShape(shape);
        }
        return;
      }
      if (applyShapeToSelection(shape)) e.preventDefault();
      return;
    }

    // Palette (1-9) and font scale (Shift + 1-9). Use e.code for the
    // shifted variant so non-US layouts where Shift+digit produces a
    // glyph still work.
    if (!mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const palette = parseInt(e.key, 10);
      // In brush mode the digit colours the *next* stroke instead of
      // recolouring the current selection — there is no selection on
      // the empty-canvas-painting workflow, and the cursor reflects
      // the chosen palette so the user can see the active colour.
      if (isBrushMode()) {
        e.preventDefault();
        setBrushPalette(palette);
        return;
      }
      if (!hasAnySelection()) return;
      if (applyPalette(palette)) {
        e.preventDefault();
        mutatedCurrentMap();
        // Only the selected items changed (#238). A selected EDGE
        // lives outside the id set — its palette bakes into the edge
        // group's class, so rebuild the edge layer when one is
        // selected.
        renderItems(w.selected);
        if (w.selectedEdge()) renderEdges();
      }
      return;
    }
    if (!mod && !e.altKey && e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      if (w.selected.size === 0) {
        // Nothing selected: Shift+1..4 in plain cursor mode sets the
        // FILE's default shape — what a double-click creates. Tool
        // modes keep their own digit semantics (brush pre-colour), so
        // they bail out here.
        if (
          /^Digit[1-4]$/.test(e.code) &&
          !isBrushMode() &&
          !isLineMode() &&
          !isTextMode()
        ) {
          e.preventDefault();
          setDefaultShape(SHAPE_FOR_KEY[parseInt(e.code.slice(5), 10)]!);
        }
        return;
      }
      const n = parseInt(e.code.slice(5), 10);
      // Apply both: font on boxes/texts, style on lines. A mixed
      // selection gets both effects from the same key.
      const fontChanged = applyFont(n);
      const styleChanged = applyLineStyle(n);
      if (fontChanged || styleChanged) {
        e.preventDefault();
        mutatedCurrentMap();
        renderItems(w.selected);
      }
      return;
    }

    // Step font size (Shift + +/-): wrap-around 1↔9. Variants tolerated
    // across keyboard layouts: US Shift+= produces "+", DE Shift++
    // produces "*", Shift+- can produce either "_" or a still-"-"
    // `e.key` depending on layout/OS, so we accept both. Must be
    // checked BEFORE the unshifted palette stepper so a Shift-modified
    // key never falls through.
    if (
      !mod && !e.altKey && e.shiftKey &&
      (e.key === "+" || e.key === "*" || e.key === "_" || e.key === "-")
    ) {
      if (w.selected.size === 0) return;
      const dir = e.key === "_" || e.key === "-" ? -1 : 1;
      if (stepFont(dir as 1 | -1)) {
        e.preventDefault();
        mutatedCurrentMap();
        renderItems(w.selected);
      }
      return;
    }

    // Step palette (+/-): wrap-around 1↔9.
    if (!mod && !e.altKey && (e.key === "+" || e.key === "=" || e.key === "-")) {
      if (!hasAnySelection()) return;
      const dir = e.key === "-" ? -1 : 1;
      if (stepPalette(dir as 1 | -1)) {
        e.preventDefault();
        mutatedCurrentMap();
        renderItems(w.selected);
        if (w.selectedEdge()) renderEdges();
      }
      return;
    }

    // Enter on a single selected box / text item enters edit mode.
    // Skipped when modifiers are held (Cmd+Enter etc. is reserved for
    // future shortcuts) or when more than one thing is selected — the
    // edit UI targets a single label.
    if (!mod && !e.altKey && !e.shiftKey && e.key === "Enter") {
      if (w.selected.size !== 1) return;
      const id = w.selected.values().next().value as string;
      const map = w.currentMap();
      const box = map.boxes.find((x) => x.id === id);
      if (box) {
        const el = w.canvas.querySelector<HTMLElement>(
          `.box[data-id="${id}"]`,
        );
        if (el) {
          e.preventDefault();
          startEdit(el, box);
        }
        return;
      }
      const text = (map.texts ?? []).find((x) => x.id === id);
      if (text) {
        const el = w.canvas.querySelector<HTMLElement>(
          `.text-item[data-id="${id}"]`,
        );
        if (el) {
          e.preventDefault();
          startTextEdit(el, text);
        }
      }
      return;
    }

    // Escape
    if (e.key === "Escape") {
      // Resize mode exits first and eats the keypress — so the first
      // Escape drops the grips but keeps the box selected, and a
      // second Escape clears the selection as usual.
      if (resizingBoxId() !== null) {
        clearBoxResize();
        applyClasses();
        return;
      }
      if (isBrushMode()) {
        setBrushMode(false);
        return;
      }
      if (isLineMode()) {
        if (isDrawingLine()) cancelPendingLine();
        else setLineMode(false);
        return;
      }
      if (isTextMode()) {
        setTextMode(false);
        return;
      }
      const link = w.link();
      if (link) {
        link.handleEl.classList.remove("active");
        w.ghostLine.style.display = "none";
        w.clearLink();
        w.setDropTargetId(null);
        w.setDropTargetHandle(null);
        applyClasses();
        w.clearProximity();
      }
      w.selected.clear();
      w.setSelectedEdge(null);
      applyClasses();
      renderEdges();
    }

    // Delete / Backspace
    if (e.key === "Delete" || e.key === "Backspace") {
      if (w.selectedEdge()) {
        e.preventDefault();
        deleteSelectedEdge();
        return;
      }
      if (w.selected.size > 0) {
        e.preventDefault();
        deleteSelection();
      }
    }
  });
};
