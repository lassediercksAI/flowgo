// Selection cloning. Used by alt-drag (duplicate the selection while
// dragging the copies). Boxes, texts, and lines all clone with fresh
// ids; edges are duplicated only when both endpoints are within the
// cloned box set so dangling references can't appear.
//
// The function mutates the supplied current map and the selected Set
// in place — the caller (main.ts) re-renders afterwards. We keep that
// shape because the caller already has to re-render, and bouncing the
// new ids back through a builder pattern would add nothing.

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
  texts: TextLike[];
  lines: LineLike[];
  edges: EdgeLike[];
}

interface CloneBindings {
  readonly currentMap: () => CurrentMap;
  readonly selected: Set<string>;
  readonly findTextById: (id: string) => TextLike | undefined;
  readonly findLineById: (id: string) => LineLike | undefined;
  readonly mintId: (prefix: string) => string;
}

let bindings: CloneBindings | null = null;
const must = (): CloneBindings => {
  if (!bindings) throw new Error("clone: wireClone() not called");
  return bindings;
};

export const wireClone = (b: CloneBindings): void => {
  bindings = b;
};

// Returns the {oldId -> newId} map. The selection Set is replaced by
// the new ids; the caller renders.
export const cloneSelection = (): Map<string, string> => {
  const { currentMap, selected, findTextById, findLineById, mintId } = must();
  const map = currentMap();
  const idMap = new Map<string, string>();
  const sourceIds = Array.from(selected);
  const cloneBoxIds = new Set<string>();

  for (const id of sourceIds) {
    const b = map.boxes.find((x) => x.id === id);
    if (b) {
      const newId = mintId("b");
      idMap.set(id, newId);
      cloneBoxIds.add(newId);
      const copy: BoxLike = { id: newId, label: b.label, x: b.x, y: b.y };
      if (b.palette) copy.palette = b.palette;
      if (b.font) copy.font = b.font;
      map.boxes.push(copy);
      continue;
    }
    const t = findTextById(id);
    if (t) {
      const newId = mintId("t");
      idMap.set(id, newId);
      const tc: TextLike = { id: newId, label: t.label, x: t.x, y: t.y };
      if (t.palette) tc.palette = t.palette;
      if (t.font) tc.font = t.font;
      map.texts.push(tc);
      continue;
    }
    const l = findLineById(id);
    if (l) {
      const newId = mintId("l");
      idMap.set(id, newId);
      const lc: LineLike = { id: newId, x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 };
      if (l.palette) lc.palette = l.palette;
      if (l.style) lc.style = l.style;
      if (l.mids?.length) lc.mids = l.mids.map(([x, y]) => [x, y]);
      map.lines.push(lc);
    }
  }

  // Duplicate edges between cloned boxes (only). Walk a snapshot of
  // edges so we don't visit the new edges we're appending.
  for (const ed of map.edges.slice()) {
    const newFrom = idMap.get(ed.from);
    const newTo = idMap.get(ed.to);
    if (newFrom && newTo && cloneBoxIds.has(newFrom) && cloneBoxIds.has(newTo)) {
      const edgeCopy: EdgeLike = { from: newFrom, to: newTo };
      if (ed.fromHandle) edgeCopy.fromHandle = ed.fromHandle;
      if (ed.toHandle) edgeCopy.toHandle = ed.toHandle;
      map.edges.push(edgeCopy);
    }
  }

  selected.clear();
  for (const newId of idMap.values()) selected.add(newId);
  return idMap;
};
