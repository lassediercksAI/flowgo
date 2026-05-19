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
  pasteSelection,
} from "./clipboard.ts";
import {
  createTextAt,
  deleteSelection,
} from "./factories.ts";
import {
  cancelPendingLine,
  isDrawingLine,
  isLineMode,
  setLineMode,
} from "./line.ts";
import {
  applyClasses,
  renderAll,
  renderEdges,
} from "./render.ts";
import { toDataX, toDataY } from "./viewport.ts";

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
  sides?: number;
  palette?: number;
  font?: number;
  anchor?: boolean;
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
  palette?: number;
}

interface StrokeLike {
  id: string;
  palette?: number;
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
  readonly lastCursor: { x: number; y: number };
  readonly scheduleSave: () => void;
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
const stepValue = (cur: number | undefined, dir: 1 | -1): number => {
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
    w.setStatus("anchor needs exactly one selected box");
    return;
  }
  const id = w.selected.values().next().value as string;
  const map = w.currentMap();
  const target = map.boxes.find((b) => b.id === id);
  if (!target) {
    w.setStatus("anchor only applies to boxes");
    return;
  }
  const turningOn = !target.anchor;
  for (const b of map.boxes) {
    if (b.anchor) delete b.anchor;
  }
  if (turningOn) target.anchor = true;
  w.scheduleSave();
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
      for (const b of map.boxes) w.selected.add(b.id);
      for (const t of map.texts ?? []) w.selected.add(t.id);
      for (const l of map.lines ?? []) w.selected.add(l.id);
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
    if (mod && !e.altKey && !e.shiftKey && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      pasteSelection();
      return;
    }

    // Single-letter shortcuts
    if (!mod && !e.altKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      createTextAt(toDataX(w.lastCursor.x), toDataY(w.lastCursor.y));
      return;
    }
    if (!mod && !e.altKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      setLineMode(!isLineMode());
      return;
    }
    if (!mod && !e.altKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      setBrushMode(true);
      return;
    }
    if (!mod && !e.altKey && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      setBrushMode(false);
      setLineMode(false);
      return;
    }
    if (!mod && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      toggleAnchor();
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
        w.scheduleSave();
        renderAll();
      }
      return;
    }
    if (!mod && !e.altKey && e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      if (w.selected.size === 0) return;
      const font = parseInt(e.code.slice(5), 10);
      if (applyFont(font)) {
        e.preventDefault();
        w.scheduleSave();
        renderAll();
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
        w.scheduleSave();
        renderAll();
      }
      return;
    }

    // Step palette (+/-): wrap-around 1↔9.
    if (!mod && !e.altKey && (e.key === "+" || e.key === "=" || e.key === "-")) {
      if (!hasAnySelection()) return;
      const dir = e.key === "-" ? -1 : 1;
      if (stepPalette(dir as 1 | -1)) {
        e.preventDefault();
        w.scheduleSave();
        renderAll();
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
      if (isBrushMode()) {
        setBrushMode(false);
        return;
      }
      if (isLineMode()) {
        if (isDrawingLine()) cancelPendingLine();
        else setLineMode(false);
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
      const sel = w.selectedEdge();
      if (sel) {
        e.preventDefault();
        const map = w.currentMap();
        const idx = map.edges.indexOf(sel);
        if (idx >= 0) map.edges.splice(idx, 1);
        w.setSelectedEdge(null);
        w.scheduleSave();
        renderEdges();
        w.setStatus("edge removed");
        return;
      }
      if (w.selected.size > 0) {
        e.preventDefault();
        deleteSelection();
      }
    }
  });
};
