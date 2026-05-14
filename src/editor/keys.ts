// Document-level keydown handler. Owns the entire shortcut surface:
// undo/redo, select-all, copy/cut/paste, T/L/B/V mode toggles, palette
// (1-9), font-size (Shift+1-9), shape cycle (+/-), Escape, Delete.
//
// Every shortcut bails when an inline label edit is in progress
// (isEditing()) so typing into a contenteditable doesn't trigger
// editor commands. Help-overlay Escape is handled before that check
// so the user can always close the help.

import { boxSides } from "../graph/sides.ts";
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
  rotation?: number;
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
}

interface CurrentMap {
  boxes: BoxLike[];
  edges: { from: string; to: string }[];
  texts: TextLike[];
  lines: LineLike[];
}

interface KeysBindings {
  readonly canvas: HTMLElement;
  readonly ghostLine: SVGLineElement;
  readonly currentMap: () => CurrentMap;
  readonly findTextById: (id: string) => TextLike | undefined;
  readonly selected: Set<string>;
  readonly selectedEdge: () => { from: string; to: string } | null;
  readonly setSelectedEdge: (
    e: { from: string; to: string } | null,
  ) => void;
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

// Cycle the shape of every selected box, preserving the visual centre
// across the resize so the camera doesn't jump.
const cycleShape = (dir: 1 | -1): boolean => {
  const w = must();
  const sel = w.selected;
  if (sel.size === 0) return false;
  const map = w.currentMap();
  const changes: Array<{ id: string; cx: number; cy: number }> = [];
  for (const id of sel) {
    const bx = map.boxes.find((x) => x.id === id);
    if (!bx) continue;
    const cur = boxSides(bx);
    const next = Math.max(3, Math.min(6, cur + dir));
    if (next === cur) continue;
    const elOld = w.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
    const cx = bx.x + (elOld ? elOld.offsetWidth : 0) / 2;
    const cy = bx.y + (elOld ? elOld.offsetHeight : 0) / 2;
    changes.push({ id, cx, cy });
    if (next === 4) delete bx.sides;
    else bx.sides = next;
  }
  if (!changes.length) return false;
  renderAll();
  for (const { id, cx, cy } of changes) {
    const bx = map.boxes.find((x) => x.id === id);
    const elNew = w.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
    if (!bx || !elNew) continue;
    bx.x = cx - elNew.offsetWidth / 2;
    bx.y = cy - elNew.offsetHeight / 2;
    elNew.style.left = bx.x + "px";
    elNew.style.top = bx.y + "px";
  }
  renderEdges();
  w.scheduleSave();
  return true;
};

// Rotate the SVG-rendered shape on every selected polygonal box
// (sides 3/5/6) by `delta` degrees. Rectangles have no rotatable
// shape and are skipped silently. Storage is normalised to [0, 360);
// 0 is dropped so the field stays optional.
const rotateSelected = (delta: number): boolean => {
  const w = must();
  if (w.selected.size === 0) return false;
  const map = w.currentMap();
  let changed = false;
  for (const id of w.selected) {
    const bx = map.boxes.find((x) => x.id === id);
    if (!bx) continue;
    if (boxSides(bx) === 4) continue;
    const cur = bx.rotation ?? 0;
    const next = (((cur + delta) % 360) + 360) % 360;
    if (next === 0) delete bx.rotation;
    else bx.rotation = next;
    changed = true;
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
  if (w.selected.size === 0) return false;
  const map = w.currentMap();
  let changed = false;
  for (const id of w.selected) {
    const target =
      map.boxes.find((x) => x.id === id) || w.findTextById(id);
    if (!target) continue;
    if (palette === 1) {
      if (target.palette) {
        delete target.palette;
        changed = true;
      }
    } else if (target.palette !== palette) {
      target.palette = palette;
      changed = true;
    }
  }
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
      if (w.selected.size === 0) return;
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

    // Rotate shape (Shift + +/-): keep the text upright, spin the
    // polygon by ±45°. Variants tolerated across keyboard layouts:
    // US Shift+= produces "+", DE Shift++ produces "*", Shift+- can
    // produce either "_" or a still-"-" `e.key` depending on layout/OS,
    // so we accept both. Must be checked BEFORE shape cycling so a
    // Shift-modified key never falls through to the cycle handler.
    if (
      !mod && !e.altKey && e.shiftKey &&
      (e.key === "+" || e.key === "*" || e.key === "_" || e.key === "-")
    ) {
      if (w.selected.size === 0) return;
      const dir = e.key === "_" || e.key === "-" ? -1 : 1;
      if (rotateSelected(dir * 45)) {
        e.preventDefault();
        renderAll();
        w.scheduleSave();
      }
      return;
    }

    // Shape cycling (+/-)
    if (!mod && !e.altKey && (e.key === "+" || e.key === "=" || e.key === "-")) {
      if (w.selected.size === 0) return;
      const dir = e.key === "-" ? -1 : 1;
      if (cycleShape(dir as 1 | -1)) {
        e.preventDefault();
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
