// Copy / cut / paste over the current selection. Owns the in-memory
// clipboard buffer; main.ts wires in the live state and id minting.
//
// Edges are duplicated only when both endpoints are present in the
// copied box set, mirroring the existing semantics. Each paste shifts
// by 20px so repeated paste presses cascade rather than stack.

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
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
  palette?: number;
  mids?: Array<[number, number]>;
  style?: number;
}

interface EdgeLike {
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
}

interface CurrentMap {
  boxes: BoxLike[];
  edges: EdgeLike[];
  texts: TextLike[];
  lines: LineLike[];
}

interface ClipboardBuffer {
  boxes: BoxLike[];
  texts: TextLike[];
  lines: LineLike[];
  edges: EdgeLike[];
  pasteOffset: number;
}

interface ClipboardBindings {
  readonly selected: Set<string>;
  readonly currentMap: () => CurrentMap;
  readonly findTextById: (id: string) => TextLike | undefined;
  readonly findLineById: (id: string) => LineLike | undefined;
  readonly mintId: (prefix: string) => string;
  readonly scheduleSave: () => void;
  readonly renderAll: () => void;
  readonly deleteSelection: () => void;
  readonly setStatus: (s: string) => void;
  readonly clearSelectedEdge: () => void;
}

let bindings: ClipboardBindings | null = null;
let buffer: ClipboardBuffer | null = null;

export const wireClipboard = (b: ClipboardBindings): void => {
  bindings = b;
};
const must = (): ClipboardBindings => {
  if (!bindings) throw new Error("clipboard: wireClipboard() not called");
  return bindings;
};

export const copySelection = (): boolean => {
  const { selected, currentMap, findTextById, findLineById } = must();
  if (selected.size === 0) return false;
  const map = currentMap();
  const boxes: BoxLike[] = [];
  const texts: TextLike[] = [];
  const lines: LineLike[] = [];
  const edges: EdgeLike[] = [];
  const boxIds = new Set<string>();
  for (const id of selected) {
    const b = map.boxes.find((x) => x.id === id);
    if (b) {
      const copy: BoxLike = { id: b.id, label: b.label, x: b.x, y: b.y };
      if (b.palette) copy.palette = b.palette;
      if (b.font) copy.font = b.font;
      boxes.push(copy);
      boxIds.add(b.id);
      continue;
    }
    const t = findTextById(id);
    if (t) {
      const tc: TextLike = { id: t.id, label: t.label, x: t.x, y: t.y };
      if (t.palette) tc.palette = t.palette;
      if (t.font) tc.font = t.font;
      texts.push(tc);
      continue;
    }
    const l = findLineById(id);
    if (l) {
      const copy: LineLike = { id: l.id, x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 };
      if (l.palette) copy.palette = l.palette;
      if (l.style) copy.style = l.style;
      if (l.mids?.length) copy.mids = l.mids.map(([x, y]) => [x, y]);
      lines.push(copy);
    }
  }
  for (const e of map.edges) {
    if (boxIds.has(e.from) && boxIds.has(e.to)) {
      edges.push({
        from: e.from,
        fromHandle: e.fromHandle ?? "",
        to: e.to,
        toHandle: e.toHandle ?? "",
      });
    }
  }
  if (!boxes.length && !texts.length && !lines.length) return false;
  buffer = { boxes, texts, lines, edges, pasteOffset: 0 };
  // Mirror box/text labels to the OS clipboard so external editors can
  // paste plain text. Internal paste still reads `buffer`, so structure
  // (edges, shapes, positions) round-trips losslessly inside flowgo.
  const labels = [...boxes, ...texts]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((item) => item.label);
  if (labels.length && typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(labels.join("\n")).catch(() => {});
  }
  return true;
};

export const cutSelection = (): void => {
  const { selected, deleteSelection, setStatus } = must();
  if (!copySelection()) {
    setStatus("nothing to cut");
    return;
  }
  const n = selected.size;
  deleteSelection();
  setStatus("cut " + n + " items");
};

export const pasteSelection = (): void => {
  const {
    selected, currentMap, mintId, scheduleSave, renderAll,
    setStatus, clearSelectedEdge,
  } = must();
  if (!buffer) {
    setStatus("clipboard is empty");
    return;
  }
  buffer.pasteOffset += 20;
  const dx = buffer.pasteOffset;
  const dy = buffer.pasteOffset;
  const idMap = new Map<string, string>();
  selected.clear();
  clearSelectedEdge();
  const map = currentMap();
  for (const b of buffer.boxes) {
    const newId = mintId("b");
    idMap.set(b.id, newId);
    const copy: BoxLike = { id: newId, label: b.label, x: b.x + dx, y: b.y + dy };
    map.boxes.push(copy);
    selected.add(newId);
  }
  for (const t of buffer.texts) {
    const newId = mintId("t");
    idMap.set(t.id, newId);
    const pasted: TextLike = { id: newId, label: t.label, x: t.x + dx, y: t.y + dy };
    if (t.palette) pasted.palette = t.palette;
    if (t.font) pasted.font = t.font;
    map.texts.push(pasted);
    selected.add(newId);
  }
  for (const l of buffer.lines) {
    const newId = mintId("l");
    idMap.set(l.id, newId);
    const pasted: LineLike = {
      id: newId,
      x1: l.x1 + dx, y1: l.y1 + dy,
      x2: l.x2 + dx, y2: l.y2 + dy,
    };
    if (l.palette) pasted.palette = l.palette;
    if (l.style) pasted.style = l.style;
    if (l.mids?.length) pasted.mids = l.mids.map(([x, y]) => [x + dx, y + dy]);
    map.lines.push(pasted);
    selected.add(newId);
  }
  for (const ed of buffer.edges) {
    const from = idMap.get(ed.from);
    const to = idMap.get(ed.to);
    if (!from || !to) continue;
    // exactOptionalPropertyTypes: omit handle keys rather than assigning undefined.
    const newEdge: EdgeLike = { from, to };
    if (ed.fromHandle) newEdge.fromHandle = ed.fromHandle;
    if (ed.toHandle) newEdge.toHandle = ed.toHandle;
    map.edges.push(newEdge);
  }
  scheduleSave();
  renderAll();
  setStatus("pasted " + selected.size + " items");
};
