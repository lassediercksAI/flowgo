// Spawn-and-delete operations for boxes, texts, lines.
//
// `createBoxAt` mints a fresh id, drops a "new" box at the cursor
// (recentred horizontally on the click after first render so the
// click point sits at the box centre), and immediately enters label-
// edit mode with the cancelDeletes path armed — Escape removes the
// just-spawned box.
//
// `createTextAt` does the same shape for free-floating text items.
// `createLineSegment` drops a line between two explicit endpoints
// (used by line-draw mode after the user clicks start and end).
//
// `deleteSelection` removes every selected item plus the submaps
// that hung off any deleted box (and edges that referenced one of
// the removed boxes).

import { startEdit, startTextEdit } from "./edit.ts";
import {
  mutatedBox,
  mutatedDoc,
  mutatedLine,
  mutatedText,
} from "./mutations.ts";
import { applyClasses, renderAll, renderEdges } from "./render.ts";

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

interface LineLike {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
}

interface CurrentMap {
  boxes: BoxLike[];
  edges: { from: string; to: string }[];
  texts: TextLike[];
  lines: LineLike[];
  strokes?: { id: string }[];
  images?: { id: string }[];
}

interface FactoryBindings {
  readonly canvas: HTMLElement;
  readonly currentMap: () => CurrentMap;
  readonly setCurrentMap: (m: CurrentMap) => void;
  readonly graph: () => { maps: { path: string }[] };
  readonly setGraph: (g: { maps: { path: string }[] }) => void;
  readonly currentPath: () => string;
  readonly ensureMap: (path: string) => CurrentMap;
  readonly selected: Set<string>;
  readonly selectedEdge: () => unknown;
  readonly clearSelectedEdge: () => void;
  readonly mintId: (prefix?: string) => string;
  readonly setStatus: (s: string) => void;
}

let bindings: FactoryBindings | null = null;
const must = (): FactoryBindings => {
  if (!bindings) throw new Error("factories: wireFactories() not called");
  return bindings;
};

export const wireFactories = (b: FactoryBindings): void => {
  bindings = b;
};

export const createBoxAt = (
  x: number,
  y: number,
  centerOn?: { x: number; y: number },
): void => {
  const w = must();
  const id = w.mintId();
  const b: BoxLike = { id, label: "new", x, y };
  w.currentMap().boxes.push(b);
  renderAll();
  const el = w.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
  if (el && centerOn) {
    b.x = centerOn.x - el.offsetWidth / 2;
    b.y = centerOn.y - el.offsetHeight / 2;
    el.style.left = b.x + "px";
    el.style.top = b.y + "px";
  }
  mutatedBox();
  if (el) {
    w.selected.clear();
    w.selected.add(id);
    if (w.selectedEdge()) {
      w.clearSelectedEdge();
      renderEdges();
    }
    applyClasses();
    startEdit(el, b);
  }
};

export const createTextAt = (cx: number, cy: number): void => {
  const w = must();
  const id = w.mintId("t");
  const t: TextLike = { id, label: "text", x: cx, y: cy };
  w.currentMap().texts.push(t);
  renderAll();
  const el = w.canvas.querySelector<HTMLElement>(`.text-item[data-id="${id}"]`);
  if (el) {
    t.x = cx - el.offsetWidth / 2;
    t.y = cy - el.offsetHeight / 2;
    el.style.left = t.x + "px";
    el.style.top = t.y + "px";
    w.selected.clear();
    w.selected.add(id);
    if (w.selectedEdge()) {
      w.clearSelectedEdge();
      renderEdges();
    }
    applyClasses();
    startTextEdit(el, t);
  }
  mutatedText();
};

export const createLineSegment = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void => {
  const w = must();
  const id = w.mintId("l");
  const l: LineLike = { id, x1, y1, x2, y2 };
  w.currentMap().lines.push(l);
  w.selected.clear();
  w.selected.add(id);
  if (w.selectedEdge()) {
    w.clearSelectedEdge();
    renderEdges();
  }
  renderAll();
  mutatedLine();
};

export const deleteSelection = (): void => {
  const w = must();
  if (w.selected.size === 0) {
    w.setStatus("nothing selected");
    return;
  }
  const sel = w.selected;
  const map = w.currentMap();
  const ids = Array.from(sel);
  const boxIds = ids.filter((id) => map.boxes.some((b) => b.id === id));
  map.boxes = map.boxes.filter((b) => !sel.has(b.id));
  map.edges = map.edges.filter((e) => !sel.has(e.from) && !sel.has(e.to));
  map.texts = map.texts.filter((t) => !sel.has(t.id));
  map.lines = map.lines.filter((l) => !sel.has(l.id));
  map.strokes = (map.strokes ?? []).filter((s) => !sel.has(s.id));
  // Media files are content-addressed and may be shared by clones /
  // pasted copies, so we leave them on disk — only the reference goes.
  map.images = (map.images ?? []).filter((i) => !sel.has(i.id));
  // Drop each deleted box's submap and any descendants.
  const cur = w.currentPath();
  const g = w.graph();
  for (const id of boxIds) {
    const removedPath = cur === "/" ? "/" + id : cur + "/" + id;
    g.maps = g.maps.filter(
      (m) => m.path !== removedPath && !m.path.startsWith(removedPath + "/"),
    );
  }
  w.setGraph(g);
  w.setCurrentMap(w.ensureMap(cur));
  sel.clear();
  mutatedDoc();
  renderAll();
};
