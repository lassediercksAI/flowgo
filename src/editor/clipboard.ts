// Copy / cut / paste over the current selection. Owns the in-memory
// clipboard buffer; main.ts wires in the live state and id minting.
//
// Edges are duplicated only when both endpoints are present in the
// copied box set, mirroring the existing semantics.
//
// PASTE CASCADE (brain#255). A paste is nudged diagonally away from
// what it was copied from, and repeated pastes step further, so you
// can always see and grab every copy. Three decisions worth keeping:
//
//   • DATA px, not screen px. The nudge is written into the document's
//     own coordinates, so a paste is reproducible: the same map + the
//     same key presses give the same file whatever the camera is
//     doing, and the copies keep their spacing when you zoom. A
//     screen-px nudge would make the saved geometry depend on the
//     zoom level at the moment you hit paste.
//
//   • 3 grid cells (GRID = 20 → 60px). The step has to clear a whole
//     default box or the copy's label lands on top of the source's
//     label and the stack is unreadable — which is exactly the bug
//     this replaced: a default box measures ~83x41 CSS px, and the
//     old 20px step buried each label under the next copy. 60 clears
//     41 with room to spare, and being a multiple of GRID keeps a
//     shift-snapped selection snapped after the paste.
//
//   • The cascade counter is PER TARGET MAP, keyed by map path, and
//     is reset by the next copy (it lives on the clipboard buffer).
//     Pasting into a map you did not copy from starts at step 0 — no
//     offset, because there is nothing there to be confused with —
//     and only cascades on the second paste into that same map. Keys
//     are paths rather than map objects so the count survives an undo
//     (undo reloads the document and swaps every map object).

import { settleHexBoxIds } from "./hex.ts";
import { GRID } from "./movers.ts";
import { mutatedCurrentMap } from "./mutations.ts";

/** Diagonal nudge applied per cascade step, in data px. See above. */
export const PASTE_OFFSET_PX = GRID * 3;

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
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
  palette?: number;
  mids?: Array<[number, number]>;
  style?: number;
}

interface ImageLike {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EdgeLike {
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
  palette?: number;
  /** Relationship label drawn at the edge midpoint (brain#266). */
  label?: string;
}

interface CurrentMap {
  boxes: BoxLike[];
  edges: EdgeLike[];
  texts: TextLike[];
  lines: LineLike[];
  images?: ImageLike[];
  /** Submap path ("/" for the root map). Present on every real map;
   *  optional here only so test doubles can stay minimal. */
  path?: string;
}

interface ClipboardBuffer {
  boxes: BoxLike[];
  texts: TextLike[];
  lines: LineLike[];
  images: ImageLike[];
  edges: EdgeLike[];
  /** Cascade steps already spent, per target map path. The source map
   *  is seeded at 0 by the copy, so its first paste steps to 1; a map
   *  that was never copied from and never pasted into is absent, so
   *  its first paste steps to 0 and lands unshifted. */
  steps: Map<string, number>;
}

const mapKey = (m: CurrentMap): string => m.path ?? "/";

interface ClipboardBindings {
  readonly selected: Set<string>;
  readonly currentMap: () => CurrentMap;
  readonly findTextById: (id: string) => TextLike | undefined;
  readonly findLineById: (id: string) => LineLike | undefined;
  readonly findImageById: (id: string) => ImageLike | undefined;
  readonly mintId: (prefix: string) => string;
  /** Incremental render of a known id set (render.ts renderItems,
   *  #238/#24f). A paste is deleteSelection's inverse — the new ids
   *  are known before anything touches the DOM — so it materializes
   *  O(pasted) elements instead of rebuilding the whole canvas. */
  readonly renderItems: (ids: Iterable<string>) => void;
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
  const { selected, currentMap, findTextById, findLineById, findImageById } = must();
  if (selected.size === 0) return false;
  const map = currentMap();
  const boxes: BoxLike[] = [];
  const texts: TextLike[] = [];
  const lines: LineLike[] = [];
  const images: ImageLike[] = [];
  const edges: EdgeLike[] = [];
  const boxIds = new Set<string>();
  for (const id of selected) {
    const b = map.boxes.find((x) => x.id === id);
    if (b) {
      const copy: BoxLike = { id: b.id, label: b.label, x: b.x, y: b.y };
      if (b.palette) copy.palette = b.palette;
      if (b.font) copy.font = b.font;
      if (b.w && b.h) {
        copy.w = b.w;
        copy.h = b.h;
      }
      if (b.shape) copy.shape = b.shape;
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
      continue;
    }
    const img = findImageById(id);
    if (img) {
      images.push({
        id: img.id,
        src: img.src,
        x: img.x,
        y: img.y,
        width: img.width,
        height: img.height,
      });
    }
  }
  for (const e of map.edges) {
    if (boxIds.has(e.from) && boxIds.has(e.to)) {
      // Everything the edge carries travels with it: dropping the
      // palette or the label here would make copy-paste quietly
      // downgrade a connection to a bare line.
      const copy: EdgeLike = {
        from: e.from,
        fromHandle: e.fromHandle ?? "",
        to: e.to,
        toHandle: e.toHandle ?? "",
      };
      if (e.palette) copy.palette = e.palette;
      if (e.label) copy.label = e.label;
      edges.push(copy);
    }
  }
  if (!boxes.length && !texts.length && !lines.length && !images.length) {
    return false;
  }
  // A fresh copy resets the cascade, and seeds the map it came from so
  // the very first paste back into it is already nudged clear of the
  // original.
  buffer = { boxes, texts, lines, images, edges, steps: new Map([[mapKey(map), 0]]) };
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
    selected, currentMap, mintId, renderItems,
    setStatus, clearSelectedEdge,
  } = must();
  if (!buffer) {
    setStatus("clipboard is empty");
    return;
  }
  const idMap = new Map<string, string>();
  selected.clear();
  clearSelectedEdge();
  const map = currentMap();
  // Advance this map's cascade. An unseen map (i.e. not the one the
  // copy came from, and not pasted into yet) starts at step 0 — the
  // copy is the only thing at those coordinates there, so shifting it
  // would just move it away from where the user copied it.
  const key = mapKey(map);
  const prev = buffer.steps.get(key);
  const step = prev === undefined ? 0 : prev + 1;
  buffer.steps.set(key, step);
  const dx = step * PASTE_OFFSET_PX;
  const dy = step * PASTE_OFFSET_PX;
  for (const b of buffer.boxes) {
    const newId = mintId("b");
    idMap.set(b.id, newId);
    const copy: BoxLike = { id: newId, label: b.label, x: b.x + dx, y: b.y + dy };
    // Carry the visual styling through the paste. palette/font were
    // captured by copySelection but previously dropped here (texts
    // kept theirs — this was an oversight, fixed alongside adding w/h).
    if (b.palette) copy.palette = b.palette;
    if (b.font) copy.font = b.font;
    if (b.w && b.h) {
      copy.w = b.w;
      copy.h = b.h;
    }
    if (b.shape) copy.shape = b.shape;
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
  if (buffer.images.length) {
    if (!map.images) map.images = [];
    for (const img of buffer.images) {
      const newId = mintId("img");
      idMap.set(img.id, newId);
      // src is reused verbatim — the media file is content-addressed
      // and can be shared by any number of references.
      map.images.push({
        id: newId,
        src: img.src,
        x: img.x + dx,
        y: img.y + dy,
        width: img.width,
        height: img.height,
      });
      selected.add(newId);
    }
  }
  for (const ed of buffer.edges) {
    const from = idMap.get(ed.from);
    const to = idMap.get(ed.to);
    if (!from || !to) continue;
    // exactOptionalPropertyTypes: omit handle keys rather than assigning undefined.
    const newEdge: EdgeLike = { from, to };
    if (ed.fromHandle) newEdge.fromHandle = ed.fromHandle;
    if (ed.toHandle) newEdge.toHandle = ed.toHandle;
    if (ed.palette) newEdge.palette = ed.palette;
    if (ed.label) newEdge.label = ed.label;
    map.edges.push(newEdge);
  }
  // The paste cascade can drop hexagons onto occupied spots (the
  // cascade step is far smaller than a hex, and a cross-map paste is
  // not shifted at all) —
  // settle them onto free lattice cells (hexes never overlap). The
  // settle can shove a PRE-EXISTING hexagon too, so its ids join the
  // render set (that's why this asks for ids, not a boolean).
  const settled = settleHexBoxIds(map.boxes);
  mutatedCurrentMap();
  // `selected` is exactly the pasted ids at this point (cleared above,
  // filled as each item was minted), so it doubles as the render set.
  const touched = new Set<string>(selected);
  for (const id of settled) touched.add(id);
  renderItems(touched);
  setStatus("pasted " + selected.size + " items");
};
