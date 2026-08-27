// Rendering: produces the live DOM/SVG representation of the current
// map.
//
// Two granularities (brain#238):
//
//   renderAll / renderLines / renderStrokes / renderEdges clear their
//   layer and rebuild from state — heavy but predictable, and the
//   right tool for structural changes (map load/switch, import,
//   undo/redo, collab remote patches).
//
//   renderItems(ids) / renderEdgesFor(boxIds) update ONLY the named
//   items: recreate (or add/remove) each item's element in place —
//   positioned by map order so stacking matches a full render — and
//   re-route only the edges incident to touched boxes. Single-item
//   mutations (move / add / delete / relabel / repalette one box) go
//   through this path, as do the bulk paths whose changed id set is
//   known up front — clipboard paste, alt-drag clone and align
//   (brain#24f) — so their cost is O(changed items), not O(map). The
//   sync guarantee stays simple: an item's element is always rebuilt
//   whole from state; there is no per-property DOM diffing to drift.
//
// applyClasses runs alone when only selection / drop-target /
// proximity classes change, so no re-render is needed for a
// selection click.

import {
  HANDLE_CODES,
  strokePathD,
} from "../index.ts";
import { hasSubmapContent } from "../graph/submap.ts";
import { isSafeImageSrc } from "../graph/image-src.ts";
import { resolveFont, resolvePalette } from "../graph/palette.ts";
import { endpointAnchor, type ElSize } from "./anchors.ts";
// The one linePathD: movers.ts owns it (it needs the same geometry to
// rewrite live paths mid-drag, and its import closure — graph/* +
// label-clamp — can never cycle back into render.ts). This module
// used to carry a byte-identical private copy that risked drifting.
import { linePathD } from "./movers.ts";
import { commitEdgeLabelEdit, editingEdge } from "./edit.ts";
import { updateSelectionToolbar } from "./align.ts";
import { refreshContextBar } from "./contextbar.ts";
import { clearBoxResize, resizingBoxId } from "./resize.ts";
import { flushLabelClamps, queueLabelClamp, shapeLabelClampFrac } from "./label-clamp.ts";
import { fixedShapeSize } from "../graph/shape.ts";
import { invalidateProximityIndex, nearestBoxWithin } from "./proximity-index.ts";
import {
  CULL_MARGIN,
  boxVisible,
  cullExemptIds,
  cullViewportRect,
  expandRect,
  edgeVisible,
  imageVisible,
  lineVisible,
  strokeVisible,
  textVisible,
  type CullRect,
} from "./culling.ts";
import {
  boxIndexOf,
  edgeIsLive,
  imageIndexOf,
  incidentEdgeIndices,
  invalidateCullIndex,
  textIndexOf,
  visibleBoxIndices,
  visibleEdgeIndices,
  visibleImageIndices,
  visibleLineIndices,
  visibleStrokeIndices,
  visibleTextIndices,
} from "./cull-index.ts";

// Corner codes for the resize grips, clockwise from top-left. Matches
// the ResizeCorner type in movers.ts; the code doubles as the CSS
// position class (rg-tl etc.) and the dataset key attach.ts reads.
const RESIZE_CORNERS = ["tl", "tr", "bl", "br"] as const;

interface BoxData {
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

interface TextData {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
}

interface LineData {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  palette?: number;
  mids?: Array<[number, number]>;
  style?: number;
}

interface EdgeData {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
  palette?: number;
  // Relationship text drawn at the edge midpoint (brain#266).
  // Undefined / empty = unlabelled.
  label?: string;
}

interface StrokeData {
  id: string;
  points: Array<readonly [number, number]>;
  palette?: number;
}

interface ImageData {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CurrentMap {
  boxes: BoxData[];
  edges: EdgeData[];
  texts: TextData[];
  lines: LineData[];
  strokes?: StrokeData[];
  images?: ImageData[];
}

interface RenderBindings {
  readonly canvas: HTMLElement;
  readonly lineLayer: SVGGElement;
  readonly strokeLayer: SVGGElement;
  readonly edgeLayer: SVGGElement;
  /** HTML sibling of the edge SVG that holds the midpoint labels.
   *  Separate from #canvas because edge labels must paint above the
   *  edge lines but below the nodes, and separate from the SVG
   *  because a label is contenteditable — which SVG <text> is not. */
  readonly edgeLabelLayer: HTMLElement;
  readonly currentMap: () => CurrentMap;
  readonly graph: () => { maps: { path: string }[] };
  readonly currentPath: () => string;
  readonly selected: Set<string>;
  readonly selectedEdge: () => EdgeData | null;
  readonly setSelectedEdge: (e: EdgeData | null) => void;
  readonly dropTargetId: () => string | null;
  readonly dropTargetHandle: () => string | null;
  readonly nearTargetId: () => string | null;
  readonly attachBoxHandlers: (el: HTMLElement, b: BoxData) => void;
  readonly attachTextHandlers: (el: HTMLElement, t: TextData) => void;
  readonly attachImageHandlers: (el: HTMLElement, img: ImageData) => void;
  readonly attachStrokeHandlers: (g: SVGGElement, s: StrokeData) => void;
  /** Open the inline editor on an edge's midpoint label (edit.ts
   *  startEdgeLabelEdit, wired through bindings so render.ts keeps
   *  its "build DOM, don't own interaction" split). */
  readonly editEdgeLabel: (el: HTMLElement, e: EdgeData) => void;
  readonly attachLineHandlers: (
    g: SVGGElement,
    line: SVGPathElement,
    hit: SVGPathElement,
    h1: SVGCircleElement,
    h2: SVGCircleElement,
    midHandles: SVGCircleElement[],
    l: LineData,
  ) => void;
  readonly isBrushMode: () => boolean;
  readonly setStatus: (s: string) => void;
}

let bindings: RenderBindings | null = null;
const must = (): RenderBindings => {
  if (!bindings) throw new Error("render: wireRender() not called");
  return bindings;
};

export const wireRender = (b: RenderBindings): void => {
  bindings = b;
};

const SVG_NS = "http://www.w3.org/2000/svg";

// id → live box element. Interaction code (proximity, link targeting,
// band select) reads box elements through this map instead of
// `canvas.querySelector('.box[data-id=…]')` — each of those was a
// full-canvas scan, and doing one PER BOX per mousemove made large
// maps unusable (brain#236: 215ms/event at 3,400 boxes). Every box
// element is created by materializeBox and removed alongside its map
// entry (renderAll wipe, updateCulling, renderItems), so an entry can
// never outlive its element.
const boxEls = new Map<string, HTMLElement>();

export const getBoxEl = (id: string): HTMLElement | null =>
  boxEls.get(id) ?? null;

// Same id → element bookkeeping for the other selectable layers, so
// applyClasses can reach a changed element directly instead of
// sweeping every layer (brain#237). Each map is owned by the render
// function that builds its elements (renderAll for texts/images,
// renderLines / renderStrokes for theirs) — cleared and refilled on
// every rebuild, so a map entry can never outlive its element.
const textEls = new Map<string, HTMLElement>();

export const getTextEl = (id: string): HTMLElement | null =>
  textEls.get(id) ?? null;

const imageEls = new Map<string, HTMLElement>();
const lineEls = new Map<string, SVGGElement>();
const strokeEls = new Map<string, SVGGElement>();

// Edge bookkeeping (brain#238). Edges have no ids, but their data
// objects are stable for as long as the edge exists (mutation sites
// splice/replace the array, then call renderEdges() full), so the
// object itself is the key. Lets renderEdgesFor re-route one box's
// incident edges in place instead of rebuilding the whole layer.
const edgeEls = new Map<EdgeData, SVGGElement>();

/** The edge data objects are the only edge identity there is (see
 *  above), so anything that starts from a DOM hit — the mouse path
 *  closes over `e` in its own listener, but touch.ts routes every
 *  target through one central classifier — needs the reverse
 *  direction. A WeakMap keyed on the element: renderEdges() drops the
 *  whole layer on every rebuild, and the entries go with the
 *  elements. */
const edgeByEl = new WeakMap<Element, EdgeData>();

/** Edge data objects double as edge identity; exported so callers
 *  that receive one back from edgeForElement can name the type. */
export type EdgeRef = EdgeData;

/** The edge whose group element (or child hit path) `el` belongs to,
 *  or null when it isn't part of an edge. Used by touch.ts's
 *  classifyTarget (brain#2e5). */
export const edgeForElement = (el: Element | null): EdgeData | null => {
  const g = el?.closest?.(".edge-group") ?? null;
  return g ? edgeByEl.get(g) ?? null : null;
};

/** Open the inline label editor on an edge, creating the label
 *  element first if the edge is still unlabelled. Shared by the
 *  mouse's dblclick handler below and touch.ts's double-tap so the
 *  two gestures cannot drift apart. */
export const openEdgeLabelEditor = (e: EdgeData): void => {
  const el = ensureEdgeLabelEl(e);
  if (el) must().editEdgeLabel(el, e);
};

// The edge whose element currently carries `.selected`, i.e. the same
// role appliedState plays for the canvas layers. Edge selection used
// to be projected exclusively by a full renderEdges() rebuild, which
// is fine while every edge-selection change is followed by one — but
// the bulk incremental paths (paste clears the selected edge and then
// renders only its own ids, brain#24f) would leave the class behind.
// applyClasses drives this through applyEdgeSelection below.
let appliedSelectedEdge: EdgeData | null = null;

const applyEdgeSelection = (w: RenderBindings): void => {
  const sel = w.selectedEdge();
  if (sel === appliedSelectedEdge) return;
  if (appliedSelectedEdge) {
    edgeEls.get(appliedSelectedEdge)?.classList.remove("selected");
  }
  if (sel) edgeEls.get(sel)?.classList.add("selected");
  appliedSelectedEdge = sel;
};

// Empty-layer singletons. `map.images ?? []` would hand the cull
// index a fresh array on every call, and the index keys its lazy
// rebuild on array identity — a new array every time means a rebuild
// every time. Same reasoning for strokes.
const NO_IMAGES: ImageData[] = [];
const NO_STROKES: StrokeData[] = [];

const imagesOf = (map: CurrentMap): readonly ImageData[] =>
  map.images ?? NO_IMAGES;
const strokesOf = (map: CurrentMap): readonly StrokeData[] =>
  map.strokes ?? NO_STROKES;

// id → box data. Used to be a Map this module rebuilt from scratch on
// every full renderEdges AND on every cull pass (#25d found the second
// one costing O(boxes) per frame). It now comes off the cull index,
// which builds the same id → array-index map as a by-product of the
// spatial index it has to build anyway, and refreshes it lazily at the
// same mutation seams.
const boxOf = (map: CurrentMap, id: string): BoxData | undefined => {
  const i = boxIndexOf(map.boxes, id);
  return i >= 0 ? map.boxes[i] : undefined;
};

// Lazy box chrome (brain#239): the 8 link handles + 4 resize grips
// are invisible except on the proximity-target / drop-target /
// selected / resizing box, yet used to be materialized on EVERY box —
// a ~7× DOM inflation (48k elements instead of ~7k at 3,400 boxes).
// Boxes now render as div+label only; chrome is created on a box when
// it first enters one of those interactive states and removed when it
// leaves them all. applyClasses is the single funnel every one of
// those state transitions already flows through, so attach/detach
// lives there — no separate tracking layer.
//
// Interaction wiring needs no per-handle work: attachBoxHandlers
// (attach.ts) installs ONE delegated mousedown listener on the box
// element and dispatches on target.classList, and the touch path
// classifies via closest('.handle') — late-created children are
// picked up automatically. Fresh chrome carries no interaction
// classes, which is exactly the invariant the appliedState===null
// resync path (below) assumes.
const chromed = new Set<string>();

const attachBoxChrome = (el: HTMLElement): void => {
  for (const code of HANDLE_CODES) {
    const h = document.createElement("div");
    h.className = "handle h-" + code;
    h.dataset["handle"] = code;
    el.appendChild(h);
  }
  // Resize grips, one per corner. Hidden until the box enters resize
  // mode (E key → `.resizing` class via applyClasses). Special shapes
  // (hex/circle/tri — the classes renderAll bakes in for fixed
  // silhouettes) get none: their size is fixed, and the E handler
  // refuses them anyway — no grips means no misleading affordance
  // even if that guard ever regresses.
  const fixedShape = el.classList.contains("hex")
    || el.classList.contains("circle")
    || el.classList.contains("tri");
  if (!fixedShape) {
    for (const corner of RESIZE_CORNERS) {
      const grip = document.createElement("div");
      grip.className = "resize-grip rg-" + corner;
      grip.dataset["corner"] = corner;
      el.appendChild(grip);
    }
  }
};

const ensureBoxChrome = (id: string | null): void => {
  if (id === null || chromed.has(id)) return;
  const el = boxEls.get(id);
  if (!el) return;
  attachBoxChrome(el);
  chromed.add(id);
};

const removeBoxChrome = (id: string): void => {
  chromed.delete(id);
  const el = boxEls.get(id);
  if (!el) return;
  const kids = el.children;
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i] as HTMLElement;
    const d = k.dataset;
    if (d && (d["handle"] !== undefined || d["corner"] !== undefined)) {
      k.remove();
    }
  }
};

// Snapshot of the class state applyClasses most recently projected
// onto the DOM. null = the DOM was just rebuilt from scratch
// (renderAll) and carries no interaction classes yet, so the next
// applyClasses applies the current state instead of diffing against
// elements that no longer exist. #238 (incremental renderAll) keeps
// this seam: whatever survives a rebuild must either keep its classes
// or reset this snapshot.
interface AppliedClassState {
  readonly selected: ReadonlySet<string>;
  readonly dropId: string | null;
  readonly dropHandle: string | null;
  readonly nearId: string | null;
  readonly resizeId: string | null;
}
let appliedState: AppliedClassState | null = null;

// Measurer for the proximity index: rendered size of a box, or null
// when it has no element (skipped, like the old querySelector loop
// did). Only called on index rebuild — all reads happen in one batch,
// so at most one forced layout per rebuild instead of per-box reads
// on every mousemove.
const getBoxSize = (id: string): { w: number; h: number } | null => {
  const el = boxEls.get(id);
  return el ? { w: el.offsetWidth, h: el.offsetHeight } : null;
};

// ── Viewport culling (brain#23a) ────────────────────────────────
// One cull evaluation: the margin-expanded viewport rect plus the id
// sets that OVERRIDE the geometric test. null = culling inactive
// (nothing wired the provider) → every item materializes, which is the
// pre-#23a behaviour and what all non-culling tests run under.
interface CullPass {
  readonly raw: CullRect;
  readonly rect: CullRect;
  readonly required: ReadonlySet<string>;
  readonly exempt: ReadonlySet<string>;
  /** Indices of the edges the rect keeps — computed once here (via the
   *  spatial index) and reused by the edge passes, which used to
   *  re-scan the whole edge array to answer the same question. */
  readonly edgeIdx: readonly number[];
}

const computeCullPass = (map: CurrentMap): CullPass | null => {
  const raw = cullViewportRect();
  if (!raw) return null;
  const rect = expandRect(raw, CULL_MARGIN);
  const w = must();
  // Interaction ids the culler must never remove: their elements are
  // load-bearing mid-gesture (proximity/drop cue chrome, resize mode,
  // link source, inline edit via the wired exemptIds) even when the
  // box itself sits off-screen. Selection is deliberately NOT exempt —
  // select-all on a 50k map must not force 50k elements into the DOM;
  // a selected box that scrolls back in gets its classes baked on
  // arrival instead (see updateCulling's appliedState reset).
  const exempt = cullExemptIds();
  const add = (id: string | null | undefined): void => {
    if (id) exempt.add(id);
  };
  add(w.dropTargetId());
  add(w.nearTargetId());
  add(resizingBoxId());
  const link = proxBindings ? proxBindings.link() : null;
  add(link?.fromId);
  add(link?.handleEl?.parentElement?.dataset?.["id"]);
  // renderEdges measures endpoint ELEMENTS, so an edge that crosses
  // the viewport with both endpoint boxes off-screen still needs both
  // boxes in the DOM. This used to walk every edge in the map
  // (requiredEdgeBoxIds); it is now O(visible edges).
  const edgeIdx = visibleEdgeIndices(map.boxes, map.edges, rect);
  const required = new Set<string>();
  for (const i of edgeIdx) {
    const e = map.edges[i]!;
    required.add(e.from);
    required.add(e.to);
  }
  return { raw, rect, required, exempt, edgeIdx };
};

const boxWanted = (b: BoxData, cull: CullPass | null): boolean =>
  cull === null
  || cull.exempt.has(b.id)
  || cull.required.has(b.id)
  || boxVisible(b, cull.rect);

const textWanted = (t: TextData, cull: CullPass | null): boolean =>
  cull === null || cull.exempt.has(t.id) || textVisible(t, cull.rect);

const imageWanted = (img: ImageData, cull: CullPass | null): boolean =>
  cull === null || cull.exempt.has(img.id) || imageVisible(img, cull.rect);

// ── Wanted-set queries (brain#25d) ──────────────────────────────
// The indices of the items a cull pass wants, in MAP ORDER: the
// spatial-index answer (O(visible)) merged with the ids the pass
// exempts or requires, which override the geometric test and are
// looked up by id through the index's id → position map. `cull ===
// null` (no provider wired) means "everything", and the caller then
// iterates the array directly rather than materializing an index list
// as long as the map.
const mergeWanted = (idx: number[], extra: number[]): number[] => {
  if (extra.length === 0) return idx;
  const seen = new Set(idx);
  for (const i of extra) if (!seen.has(i)) idx.push(i);
  idx.sort((a, b) => a - b);
  return idx;
};

const wantedBoxIndices = (map: CurrentMap, cull: CullPass): number[] => {
  const extra: number[] = [];
  const add = (id: string): void => {
    const i = boxIndexOf(map.boxes, id);
    if (i >= 0 && !boxVisible(map.boxes[i]!, cull.rect)) extra.push(i);
  };
  for (const id of cull.exempt) add(id);
  for (const id of cull.required) add(id);
  return mergeWanted(visibleBoxIndices(map.boxes, cull.rect), extra);
};

const wantedTextIndices = (map: CurrentMap, cull: CullPass): number[] => {
  const extra: number[] = [];
  for (const id of cull.exempt) {
    const i = textIndexOf(map.texts, id);
    if (i >= 0 && !textVisible(map.texts[i]!, cull.rect)) extra.push(i);
  }
  return mergeWanted(visibleTextIndices(map.texts, cull.rect), extra);
};

const wantedImageIndices = (map: CurrentMap, cull: CullPass): number[] => {
  const images = imagesOf(map);
  const extra: number[] = [];
  for (const id of cull.exempt) {
    const i = imageIndexOf(images, id);
    if (i >= 0 && !imageVisible(images[i]!, cull.rect)) extra.push(i);
  }
  return mergeWanted(visibleImageIndices(images, cull.rect), extra);
};

/** Indices 0..n-1 — the "culling is off" answer, so every caller can
 *  drive one loop over an index list regardless. */
const allIndices = (n: number): number[] => {
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
};

// The raw viewport rect the last cull evaluation ran against. Used by
// scheduleCullUpdate to skip re-evaluating while the viewport has
// moved less than CULL_REEVAL_SLACK — the margin guarantees anything
// inside `slack` of the old rect is still materialized, so panning
// re-culls every ~half margin of travel instead of every frame.
let lastCullRect: CullRect | null = null;

// First live element at or after `from` in `arr` — the insertBefore
// anchor that puts a late-created element at its map position. A data
// scan over Map lookups (no DOM reads); O(items) worst case, hit only
// when materializing.
const nextEl = <T extends { id: string }, E extends Element>(
  arr: readonly T[],
  from: number,
  els: Map<string, E>,
): E | null => {
  for (let i = from; i < arr.length; i++) {
    const el = els.get(arr[i]!.id);
    if (el) return el;
  }
  return null;
};

// id → array index for one layer. renderItems used to locate each id
// with a findIndex scan, which is fine for one item and quadratic for
// a bulk insert: a 200-item paste on a 3,400-box map spent 680k
// comparisons before creating a single element (brain#24f). Built at
// most once per layer per renderItems call — O(map) once, O(1) per id.
const indexById = <T extends { id: string }>(
  arr: readonly T[],
): Map<string, number> => {
  const m = new Map<string, number>();
  for (let i = 0; i < arr.length; i++) m.set(arr[i]!.id, i);
  return m;
};

// Canvas child order is boxes → texts → images (renderAll appends in
// that order), so a box's anchor may fall through to the first live
// text/image, and a text's to the first live image.
const boxAnchor = (map: CurrentMap, i: number): HTMLElement | null =>
  nextEl(map.boxes, i + 1, boxEls)
  ?? nextEl(map.texts, 0, textEls)
  ?? nextEl(map.images ?? [], 0, imageEls);

const textAnchor = (map: CurrentMap, i: number): HTMLElement | null =>
  nextEl(map.texts, i + 1, textEls)
  ?? nextEl(map.images ?? [], 0, imageEls);

const imageAnchor = (map: CurrentMap, i: number): HTMLElement | null =>
  nextEl(map.images ?? [], i + 1, imageEls);

// Materialize one box: element, map entry, handlers, label clamps.
// Shared verbatim between renderAll's build loop, updateCulling's
// pan-in path and renderItems' rebuild path so a late-materialized
// box is indistinguishable from a renderAll-built one (minus
// interaction classes, which the caller bakes — via the
// appliedState=null resync or bakeBoxState).
//
// `before` positions the element in map order (insertBefore; null =
// append) so late-created elements stack exactly like a full render.
const materializeBox = (
  w: RenderBindings,
  g: { maps: { path: string }[] },
  cur: string,
  b: BoxData,
  before: HTMLElement | null = null,
): void => {
  const el = document.createElement("div");
  const palette = resolvePalette(b.palette);
  const font = resolveFont(b.font);
  el.className = "box"
    + (b.shape === 1 ? " hex" : b.shape === 2 ? " circle" : b.shape === 3 ? " tri" : "")
    + (hasSubmapContent(g, cur, b.id) ? " has-submap" : "")
    + (palette !== 1 ? " palette-" + palette : "")
    + (font !== 1 ? " font-" + font : "");
  el.dataset["id"] = b.id;
  boxEls.set(b.id, el);
  el.style.left = b.x + "px";
  el.style.top = b.y + "px";
  const fixed = fixedShapeSize(b.shape);
  if (fixed) {
    // Special shapes are uniform and never resizable: always their
    // fixed footprint (for hexagons the lattice snap math in
    // ../graph/hex.ts depends on every hexagon sharing exactly this
    // size). Takes precedence over any stray w/h from the resize
    // feature.
    el.style.width = fixed.w + "px";
    el.style.height = fixed.h + "px";
  } else if (b.w && b.h) {
    // Explicit size (resize feature): pin width/height and switch on
    // the `sized` class so CSS centers the label inside the fixed
    // frame instead of the box hugging its content.
    el.style.width = b.w + "px";
    el.style.height = b.h + "px";
    el.classList.add("sized");
  }
  const label = document.createElement("span");
  label.className = "box-label";
  label.textContent = b.label;
  el.appendChild(label);
  // No handles / resize grips here: chrome attaches lazily via
  // applyClasses when the box becomes proximity-target / selected /
  // drop-target / resizing (brain#239, see attachBoxChrome above).
  w.canvas.insertBefore(el, before);
  w.attachBoxHandlers(el, b);
  // Fixed-frame boxes clamp their label to the lines that fit the
  // frame: sized rectangles against their own content box, special
  // shapes against a per-shape usable-height fraction (the silhouette
  // would otherwise be overrun, since the box can't grow).
  //
  // QUEUED, not measured here (#258): measuring immediately after
  // insertBefore forces a style+layout flush per box. The caller
  // flushes once when the batch is built — see flushLabelClamps.
  if (el.classList.contains("sized")) queueLabelClamp(el, null);
  else {
    const frac = shapeLabelClampFrac(b.shape);
    if (frac) queueLabelClamp(el, frac);
  }
};

const materializeText = (
  w: RenderBindings,
  t: TextData,
  before: HTMLElement | null = null,
): void => {
  const el = document.createElement("div");
  const tPalette = resolvePalette(t.palette);
  const tFont = resolveFont(t.font);
  el.className = "text-item"
    + (tPalette !== 1 ? " palette-" + tPalette : "")
    + (tFont !== 1 ? " font-" + tFont : "");
  el.dataset["id"] = t.id;
  textEls.set(t.id, el);
  el.style.left = t.x + "px";
  el.style.top = t.y + "px";
  el.textContent = t.label;
  w.canvas.insertBefore(el, before);
  w.attachTextHandlers(el, t);
};

const materializeImage = (
  w: RenderBindings,
  img: ImageData,
  before: HTMLElement | null = null,
): void => {
  const el = document.createElement("div");
  el.className = "image-item";
  el.dataset["id"] = img.id;
  imageEls.set(img.id, el);
  el.style.left = img.x + "px";
  el.style.top = img.y + "px";
  el.style.width = img.width + "px";
  el.style.height = img.height + "px";
  const im = document.createElement("img");
  // Defense in depth (see graph/image-src.ts): a crafted .flowgo file
  // opened locally never touches a server-side validator, so this is
  // the last check between an attacker-controlled src and img.src.
  if (isSafeImageSrc(img.src)) im.src = img.src;
  im.draggable = false;
  im.alt = "";
  el.appendChild(im);
  // Resize grip, bottom-right. Hidden until the image is selected
  // (CSS gates it on .image-item.selected).
  const grip = document.createElement("div");
  grip.className = "image-resize-handle";
  el.appendChild(grip);
  w.canvas.insertBefore(el, before);
  w.attachImageHandlers(el, img);
};

export const renderAll = (): void => {
  const w = must();
  w.canvas.innerHTML = "";
  boxEls.clear();
  textEls.clear();
  imageEls.clear();
  // Every box element (and therefore every attached chrome child) was
  // just destroyed; applyClasses below re-attaches chrome to whichever
  // boxes are currently entitled to it.
  chromed.clear();
  // The previously-applied class snapshot refers to elements that
  // were just destroyed — applyClasses below must apply the current
  // state to the fresh DOM, not diff against the dead one.
  appliedState = null;
  // Elements (and possibly sizes) were just rebuilt — cached rects in
  // the proximity index are meaningless now.
  invalidateProximityIndex();
  // renderAll is the "something structural changed" funnel — document
  // load, undo/redo, map switch, collab apply. Those paths swap graph
  // slices WITHOUT going through mutations.ts fire(), so this is the
  // cull index's second invalidation seam (#25d); the array-identity
  // check inside the index is the third.
  invalidateCullIndex();
  const map = w.currentMap();
  const g = w.graph();
  const cur = w.currentPath();
  // Viewport culling (#23a): only items inside viewport+margin (plus
  // the exempt/required overrides) get DOM. cull === null (no provider
  // wired) materializes everything.
  const cull = computeCullPass(map);
  lastCullRect = cull ? cull.raw : null;
  const images = imagesOf(map);
  // Ascending map order into an empty canvas, so plain appends put
  // every element at its map position without anchor bookkeeping.
  for (const i of cull ? wantedBoxIndices(map, cull) : allIndices(map.boxes.length)) {
    materializeBox(w, g, cur, map.boxes[i]!);
  }
  for (const i of cull ? wantedTextIndices(map, cull) : allIndices(map.texts.length)) {
    materializeText(w, map.texts[i]!);
  }
  for (const i of cull ? wantedImageIndices(map, cull) : allIndices(images.length)) {
    materializeImage(w, images[i]!);
  }
  // Every insertion is done: one measure+write pass for all the
  // fixed-frame labels queued above (#258), before anything
  // downstream reads geometry.
  flushLabelClamps();
  applyClasses();
  renderLines();
  renderStrokes();
  renderEdges();
};

// Margin-expanded viewport rect for the SVG layers (lines / strokes /
// edges), or null when culling is off. These layers need no
// exempt/required overrides: their elements aren't gesture-anchors the
// way box elements are, and every class toggle on a missing element is
// already a safe no-op through the element maps.
const cullLayerRect = (): CullRect | null => {
  const raw = cullViewportRect();
  return raw ? expandRect(raw, CULL_MARGIN) : null;
};

// Build one stroke group. `selected` bakes in at build time from the
// live selection — safe because every build path calls applyClasses
// before the selection can change again (#237's force-toggle diff
// then converges the snapshot).
const materializeStroke = (
  w: RenderBindings,
  s: StrokeData,
  before: SVGGElement | null = null,
): SVGGElement => {
  const d = strokePathD(s.points);
  const g = document.createElementNS(SVG_NS, "g");
  const pal = resolvePalette(s.palette);
  g.setAttribute(
    "class",
    "stroke-group"
      + (pal !== 1 ? " palette-" + pal : "")
      + (w.selected.has(s.id) ? " selected" : ""),
  );
  g.dataset["id"] = s.id;
  strokeEls.set(s.id, g);

  const hit = document.createElementNS(SVG_NS, "path");
  hit.setAttribute("class", "stroke-hit");
  hit.setAttribute("d", d);
  hit.setAttribute("fill", "none");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "12");
  g.appendChild(hit);

  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("class", "stroke-line");
  line.setAttribute("d", d);
  line.setAttribute("fill", "none");
  g.appendChild(line);

  // Selection + body-drag wiring lives in attach.ts (shared drag
  // machinery, same as line bodies) — supplied via bindings to keep
  // the render → attach dependency direction acyclic.
  w.attachStrokeHandlers(g, s);

  w.strokeLayer.insertBefore(g, before);
  return g;
};

export const renderStrokes = (): void => {
  const w = must();
  w.strokeLayer.innerHTML = "";
  strokeEls.clear();
  const map = w.currentMap();
  const rect = cullLayerRect();
  const strokes = strokesOf(map);
  for (const i of rect ? visibleStrokeIndices(strokes, rect) : allIndices(strokes.length)) {
    const s = strokes[i]!;
    if (!s.points || s.points.length < 2) continue;
    materializeStroke(w, s);
  }
};

// Build one line group (body + hit path + endpoint/mid handles).
// Same bake-selected-at-build convention as materializeStroke.
const materializeLine = (
  w: RenderBindings,
  l: LineData,
  before: SVGGElement | null = null,
): SVGGElement => {
  const g = document.createElementNS(SVG_NS, "g");
  const lPal = resolvePalette(l.palette);
  g.setAttribute(
    "class",
    "line-group"
      + (lPal !== 1 ? " palette-" + lPal : "")
      + (w.selected.has(l.id) ? " selected" : ""),
  );
  g.dataset["id"] = l.id;
  lineEls.set(l.id, g);

  const d = linePathD(l);

  const hit = document.createElementNS(SVG_NS, "path");
  hit.setAttribute("class", "line-hit");
  hit.setAttribute("d", d);
  hit.setAttribute("fill", "none");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "12");
  g.appendChild(hit);

  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("class", "line-line");
  line.setAttribute("d", d);
  line.setAttribute("fill", "none");
  g.appendChild(line);

  const h1 = document.createElementNS(SVG_NS, "circle");
  h1.setAttribute("class", "line-handle");
  h1.setAttribute("cx", String(l.x1));
  h1.setAttribute("cy", String(l.y1));
  h1.setAttribute("r", "6");
  h1.dataset["endpoint"] = "1";
  g.appendChild(h1);

  const h2 = document.createElementNS(SVG_NS, "circle");
  h2.setAttribute("class", "line-handle");
  h2.setAttribute("cx", String(l.x2));
  h2.setAttribute("cy", String(l.y2));
  h2.setAttribute("r", "6");
  h2.dataset["endpoint"] = "2";
  g.appendChild(h2);

  const midHandles: SVGCircleElement[] = [];
  for (let i = 0; i < (l.mids?.length ?? 0); i++) {
    const [mx, my] = l.mids![i]!;
    const mh = document.createElementNS(SVG_NS, "circle");
    mh.setAttribute("class", "line-handle line-handle-mid");
    mh.setAttribute("cx", String(mx));
    mh.setAttribute("cy", String(my));
    mh.setAttribute("r", "6");
    mh.dataset["endpoint"] = "m";
    mh.dataset["midIndex"] = String(i);
    g.appendChild(mh);
    midHandles.push(mh);
  }

  w.attachLineHandlers(g, line, hit, h1, h2, midHandles, l);
  w.lineLayer.insertBefore(g, before);
  return g;
};

export const renderLines = (): void => {
  const w = must();
  w.lineLayer.innerHTML = "";
  lineEls.clear();
  const map = w.currentMap();
  const rect = cullLayerRect();
  // Segment-accurate visibility (#23a): a line whose endpoints are
  // both far off-screen still renders when its path crosses the
  // viewport. The index buckets lines by the cells their segments
  // actually traverse, so that stays true (see cull-index.ts) —
  // lineVisible still has the final say.
  for (const i of rect ? visibleLineIndices(map.lines, rect) : allIndices(map.lines.length)) {
    materializeLine(w, map.lines[i]!);
  }
};

// Set/clear `selected` on whatever element carries this id. Ids are
// globally unique per map, but checking every layer's map mirrors the
// old per-layer sweeps exactly — at most one map hits, the misses are
// O(1) lookups.
const toggleSelected = (id: string, on: boolean): void => {
  boxEls.get(id)?.classList.toggle("selected", on);
  textEls.get(id)?.classList.toggle("selected", on);
  imageEls.get(id)?.classList.toggle("selected", on);
  lineEls.get(id)?.classList.toggle("selected", on);
  strokeEls.get(id)?.classList.toggle("selected", on);
};

// Set/clear `.target` on one specific handle of one box. Handles are
// direct children of the box element (see renderAll), so an index
// walk over ~13 children replaces the old per-box querySelectorAll.
const toggleTargetHandle = (boxId: string, handle: string, on: boolean): void => {
  const el = boxEls.get(boxId);
  if (!el) return;
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) {
    const h = kids[i] as HTMLElement;
    if (h.dataset && h.dataset["handle"] === handle) {
      h.classList.toggle("target", on);
      return;
    }
  }
};

// Diff-based since brain#237: instead of sweeping every box (+ every
// handle child), text, image, line and stroke on each call — 15k
// class toggles per selection click at 1,200 boxes — applyClasses
// keeps a snapshot of the last state it projected onto the DOM and
// touches only elements whose state changed. A single-box selection
// change costs O(changed); a band select costs O(selection delta).
//
// Every toggle uses an explicit force flag, so re-touching an element
// that a rebuild already put in the right state (renderLines /
// renderStrokes bake `selected` in at build time) is a no-op — the
// diff stays correct even when callers rebuild a layer between
// applyClasses calls.
export const applyClasses = (): void => {
  const w = must();
  const dropId = w.dropTargetId();
  const dropHandle = w.dropTargetHandle();
  const nearId = w.nearTargetId();
  // Resize mode only survives while its box stays selected. Selection
  // moved / cleared / box deleted → the mode drops here, which is the
  // one funnel every selection change already flows through.
  const pre = resizingBoxId();
  if (pre !== null && !w.selected.has(pre)) {
    clearBoxResize();
  }
  const resizeId = resizingBoxId();

  // Materialize chrome on every box that can need it BEFORE any class
  // toggles below — toggleTargetHandle can only mark a `.target`
  // handle that exists, and the coarse-pointer CSS shows handles on
  // every selected box. The link source keeps its chrome too so the
  // `.active` handle cue survives a drag that wanders away from it
  // (during a re-route the picked-up handle lives on a DIFFERENT box
  // than link.fromId — entitle both). Ensure is O(1) per already-
  // chromed box, so re-walking the selection each call stays cheap.
  const link = proxBindings ? proxBindings.link() : null;
  const linkHandleBoxId = link?.handleEl?.parentElement?.dataset?.["id"] ?? null;
  for (const id of w.selected) ensureBoxChrome(id);
  ensureBoxChrome(dropId);
  ensureBoxChrome(nearId);
  ensureBoxChrome(resizeId);
  ensureBoxChrome(link?.fromId ?? null);
  ensureBoxChrome(linkHandleBoxId);

  const prev = appliedState;
  if (prev === null) {
    // Fresh DOM (renderAll just rebuilt everything): no interaction
    // classes exist yet, so apply the current state additively —
    // O(selected), not O(all elements).
    for (const id of w.selected) toggleSelected(id, true);
    if (dropId !== null) {
      boxEls.get(dropId)?.classList.toggle("drop-target", true);
      if (dropHandle !== null) toggleTargetHandle(dropId, dropHandle, true);
    }
    if (nearId !== null) boxEls.get(nearId)?.classList.toggle("proximity-target", true);
    if (resizeId !== null) boxEls.get(resizeId)?.classList.toggle("resizing", true);
  } else {
    // Selection: symmetric difference against the snapshot.
    for (const id of prev.selected) {
      if (!w.selected.has(id)) toggleSelected(id, false);
    }
    for (const id of w.selected) {
      if (!prev.selected.has(id)) toggleSelected(id, true);
    }
    if (prev.dropId !== dropId) {
      if (prev.dropId !== null) boxEls.get(prev.dropId)?.classList.toggle("drop-target", false);
      if (dropId !== null) boxEls.get(dropId)?.classList.toggle("drop-target", true);
    }
    // The old sweep cleared `.target` on every handle of every box so
    // a stale one couldn't linger; the diff clears the PREVIOUS drop
    // target's handle explicitly instead — applyClasses is the only
    // writer of `.target`, so that one handle is the only candidate.
    if (prev.dropId !== dropId || prev.dropHandle !== dropHandle) {
      if (prev.dropId !== null && prev.dropHandle !== null) {
        toggleTargetHandle(prev.dropId, prev.dropHandle, false);
      }
      if (dropId !== null && dropHandle !== null) {
        toggleTargetHandle(dropId, dropHandle, true);
      }
    }
    if (prev.nearId !== nearId) {
      if (prev.nearId !== null) boxEls.get(prev.nearId)?.classList.toggle("proximity-target", false);
      if (nearId !== null) boxEls.get(nearId)?.classList.toggle("proximity-target", true);
    }
    if (prev.resizeId !== resizeId) {
      if (prev.resizeId !== null) boxEls.get(prev.resizeId)?.classList.toggle("resizing", false);
      if (resizeId !== null) boxEls.get(resizeId)?.classList.toggle("resizing", true);
    }
  }
  appliedState = {
    selected: new Set(w.selected),
    dropId,
    dropHandle,
    nearId,
    resizeId,
  };
  // Detach chrome from boxes that no longer need it. Runs AFTER the
  // toggles so class-off writes above hit live elements; iterating
  // `chromed` while deleting is safe (Set iteration tolerates deletes
  // of the current entry). The set only ever holds interactive boxes,
  // so this sweep is O(selection + a handful), never O(canvas).
  for (const id of chromed) {
    if (
      w.selected.has(id)
      || id === dropId
      || id === nearId
      || id === resizeId
      || id === (link?.fromId ?? null)
      || id === linkHandleBoxId
    ) continue;
    removeBoxChrome(id);
  }
  applyEdgeSelection(w);
  updateSelectionToolbar();
  refreshContextBar();
};

interface EdgeCoords {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

// Per-pass snapshot of box element sizes (brain#25b). Every edge
// endpoint needs offsetWidth/offsetHeight, and an edge pass reads the
// same box element once per incident edge — each read while the
// document is dirty forces a synchronous layout. Taking the reads
// through one cache, in a phase that does no writes, collapses a
// render into a SINGLE forced reflow instead of roughly one per five
// edges. The snapshot is per pass, never cached across calls: a box
// resize or a relabel changes these numbers.
type SizeCache = (el: HTMLElement) => ElSize;

const makeSizeCache = (): SizeCache => {
  const seen = new Map<HTMLElement, ElSize>();
  return (el) => {
    let s = seen.get(el);
    if (!s) {
      s = { offsetWidth: el.offsetWidth, offsetHeight: el.offsetHeight };
      seen.set(el, s);
    }
    return s;
  };
};

// Anchor endpoints of an edge, from the endpoint elements' sizes.
// Pure once the sizes are in hand — no DOM access of its own.
const edgeGeometry = (
  e: EdgeData,
  a: BoxData,
  b: BoxData,
  ea: ElSize,
  eb: ElSize,
): EdgeCoords => {
  const acx = a.x + ea.offsetWidth / 2;
  const acy = a.y + ea.offsetHeight / 2;
  const bcx = b.x + eb.offsetWidth / 2;
  const bcy = b.y + eb.offsetHeight / 2;
  const [ax, ay] = endpointAnchor(a, ea, e.fromHandle, bcx, bcy);
  const [bx, by] = endpointAnchor(b, eb, e.toHandle, acx, acy);
  return { ax, ay, bx, by };
};

// Write the four line coordinates onto an existing edge group's hit +
// visible children (fixed structure, see materializeEdge) — the
// re-route primitive renderEdgesFor uses per incident edge.
const setEdgeCoords = (g: SVGGElement, c: EdgeCoords): void => {
  const kids = g.children;
  for (let i = 0; i < 2; i++) {
    const el = kids[i];
    if (!el) continue;
    el.setAttribute("x1", String(c.ax));
    el.setAttribute("y1", String(c.ay));
    el.setAttribute("x2", String(c.bx));
    el.setAttribute("y2", String(c.by));
  }
};

// Read an edge group's current coordinates back off the attributes we
// wrote. Attribute reads are not layout reads, so this is free — it is
// how the label paths re-derive a midpoint without re-measuring the
// endpoint boxes.
const edgeCoordsOf = (g: SVGGElement): EdgeCoords | null => {
  const el = g.children[0];
  if (!el) return null;
  return {
    ax: Number(el.getAttribute("x1")),
    ay: Number(el.getAttribute("y1")),
    bx: Number(el.getAttribute("x2")),
    by: Number(el.getAttribute("y2")),
  };
};

// ── Edge labels (brain#266) ─────────────────────────────────────
// The label is an HTML div in its own layer rather than an SVG <text>
// inside the edge group, for two reasons: SVG text is not
// contenteditable, so inline editing would need a second editor; and
// `transform: translate(-50%, -50%)` centres the div on the midpoint
// using its OWN rendered size, which means the renderer never measures
// a label — no text metrics, no getBBox, nothing that could reopen
// the layout thrash brain#258 closed.
//
// Lifecycle is tied to the edge group: an element exists only while
// its edge is materialized, so a label culls exactly when its edge
// does — including the case where both endpoint boxes are off-screen
// but the edge crosses the viewport (edgeVisible decides, once, for
// both).
const edgeLabelEls = new Map<EdgeData, HTMLElement>();

export const getEdgeLabelEl = (e: EdgeData): HTMLElement | null =>
  edgeLabelEls.get(e) ?? null;

const placeEdgeLabel = (el: HTMLElement, c: EdgeCoords): void => {
  // Edges render as straight lines, so the midpoint is exact — and it
  // stays exact through endpoint moves and re-routes because every
  // path that rewrites the coordinates calls straight through here.
  el.style.left = (c.ax + c.bx) / 2 + "px";
  el.style.top = (c.ay + c.by) / 2 + "px";
};

// Create the label element for an edge that doesn't have one yet.
// Exported through ensureEdgeLabelEl for the double-click path, which
// has to open an editor on an edge that is currently unlabelled.
const makeEdgeLabelEl = (w: RenderBindings, e: EdgeData): HTMLElement => {
  const el = document.createElement("div");
  // The label inherits its edge's palette (the card's "beyond
  // inheriting the edge's" is explicitly out of scope). Baking the
  // class in at creation is safe because the only way to change an
  // edge's palette — keys.ts applyPalette — follows up with a full
  // renderEdges(), which rebuilds this element from scratch.
  const pal = resolvePalette(e.palette);
  el.className = "edge-label" + (pal !== 1 ? " palette-" + pal : "");
  // Keep pointer interaction local: a drag started on the label must
  // not pan the canvas or start a band selection underneath.
  el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  el.addEventListener("dblclick", (ev) => {
    if (el.isContentEditable) return;
    ev.preventDefault();
    ev.stopPropagation();
    must().editEdgeLabel(el, e);
  });
  edgeLabelEls.set(e, el);
  w.edgeLabelLayer.appendChild(el);
  return el;
};

// Bring the label element in line with the edge's data + coordinates:
// create it if the edge gained a label, drop it if the edge lost one,
// otherwise just move it. An edge whose label is being edited keeps
// its element and its typed-in text regardless of what the data says
// (the data only catches up on commit).
const syncEdgeLabel = (
  w: RenderBindings,
  e: EdgeData,
  c: EdgeCoords,
): void => {
  const editing = editingEdge() === e;
  const text = e.label ?? "";
  let el = edgeLabelEls.get(e);
  if (text === "" && !editing) {
    if (el) {
      el.remove();
      edgeLabelEls.delete(e);
    }
    return;
  }
  if (!el) el = makeEdgeLabelEl(w, e);
  if (!editing) el.textContent = text;
  placeEdgeLabel(el, c);
};

// The label element for `e`, created on demand. The double-click
// handler on the edge line uses this: an unlabelled edge has no
// element until the user asks for one.
export const ensureEdgeLabelEl = (e: EdgeData): HTMLElement | null => {
  const w = must();
  const g = edgeEls.get(e);
  if (!g) return null;
  const c = edgeCoordsOf(g);
  if (!c) return null;
  const el = edgeLabelEls.get(e) ?? makeEdgeLabelEl(w, e);
  el.textContent = e.label ?? "";
  placeEdgeLabel(el, c);
  return el;
};

// Re-sync every materialized edge's label from its data, reusing the
// coordinates already on the SVG. Pure attribute reads + writes: no
// layout is forced, so this is safe to call on every label commit.
export const renderEdgeLabels = (): void => {
  if (!bindings) return;
  const w = must();
  for (const [e, g] of edgeEls) {
    const c = edgeCoordsOf(g);
    if (c) syncEdgeLabel(w, e, c);
  }
};

// Drop an edge's DOM: the SVG group and, unless it is mid-edit, its
// label. Single funnel so no removal path can forget the label and
// leave it floating over a line that no longer exists.
const dropEdgeEls = (e: EdgeData, g: SVGGElement): void => {
  g.remove();
  edgeEls.delete(e);
  const label = edgeLabelEls.get(e);
  if (label) {
    label.remove();
    edgeLabelEls.delete(e);
  }
};

// Build one edge group. Z-order within the edge layer is append-only:
// edges are visually uniform 1px lines, so stacking among them is
// imperceptible — not worth positioned insertion (unlike canvas items).
const materializeEdge = (
  w: RenderBindings,
  e: EdgeData,
  c: EdgeCoords,
  sel: EdgeData | null,
): void => {
  const g = document.createElementNS(SVG_NS, "g");
  const ePal = resolvePalette(e.palette);
  g.setAttribute(
    "class",
    "edge-group"
      + (ePal !== 1 ? " palette-" + ePal : "")
      + (e === sel ? " selected" : ""),
  );

  const hit = document.createElementNS(SVG_NS, "line");
  hit.setAttribute("class", "edge-hit");
  hit.setAttribute("stroke", "transparent");
  hit.setAttribute("stroke-width", "12");
  g.appendChild(hit);

  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "edge-line");
  g.appendChild(line);

  setEdgeCoords(g, c);

  g.addEventListener("mousedown", (ev) => {
    ev.stopPropagation();
    w.setSelectedEdge(e);
    w.selected.clear();
    // applyClasses → applyEdgeSelection moves `.selected` between the
    // old and new edge elements (#24f). The full renderEdges() this
    // used to call as well was redundant — and actively harmful: it
    // destroyed this very element between the two clicks of a
    // double-click, so the browser found no common ancestor to
    // dispatch `dblclick` to and the label editor could never open
    // (brain#266). Selecting an edge is now O(1), not O(edges).
    applyClasses();
    w.setStatus("edge selected — press Delete to remove, double-click to label");
  });

  // Double-click the line itself to label it. The bg-layer's
  // dblclick (which spawns a node) never sees this: the listener is
  // on #bg-layer, and #edges is a sibling SVG above it, so a click
  // that lands on `.edge-hit` is not in that element's ancestor
  // chain at all. stopPropagation is belt-and-braces for the day
  // someone moves the listener to document.
  g.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openEdgeLabelEditor(e);
  });

  edgeEls.set(e, g);
  edgeByEl.set(g, e);
  if (e === sel) appliedSelectedEdge = e;
  w.edgeLayer.appendChild(g);
  syncEdgeLabel(w, e, c);
};

export const renderEdges = (): void => {
  const w = must();
  // A live inline edit is about to lose its element. Commit it first
  // — Chrome fires no blur for a detached node, so leaving it would
  // wedge the editing flag and lock out every keyboard shortcut.
  commitEdgeLabelEdit();
  w.edgeLayer.innerHTML = "";
  w.edgeLabelLayer.innerHTML = "";
  edgeEls.clear();
  edgeLabelEls.clear();
  // Every edge element (and its `.selected` class) just died;
  // materializeEdge re-bakes the current one below.
  appliedSelectedEdge = null;
  const map = w.currentMap();
  const sel = w.selectedEdge();
  const rect = cullLayerRect();
  // Cull by the segment between the endpoint boxes (expanded by
  // EDGE_REACH for the anchor offsets) — an edge crossing the viewport
  // with both boxes off-screen still renders; its endpoint boxes are
  // force-materialized via the cull pass's `required` set so the
  // element measuring keeps working. O(visible edges) since #25d.
  const idx = rect
    ? visibleEdgeIndices(map.boxes, map.edges, rect)
    : allIndices(map.edges.length);
  // Two phases (brain#25b): every endpoint measurement happens here,
  // through one size cache and with no interleaved writes, so the
  // whole pass costs ONE forced layout instead of one per few edges.
  const size = makeSizeCache();
  const jobs: Array<{ e: EdgeData; c: EdgeCoords }> = [];
  for (const i of idx) {
    const e = map.edges[i]!;
    const a = boxOf(map, e.from);
    const b = boxOf(map, e.to);
    if (!a || !b) continue;
    const ea = boxEls.get(e.from);
    const eb = boxEls.get(e.to);
    if (!ea || !eb) continue;
    jobs.push({ e, c: edgeGeometry(e, a, b, size(ea), size(eb)) });
  }
  for (const job of jobs) materializeEdge(w, job.e, job.c, sel);
};

// Re-route ONLY the edges incident to `ids` (box ids; non-box ids in
// the set simply match nothing, so callers can pass a mixed selection
// verbatim). Surviving incident edges get their coordinates rewritten
// in place; edges whose data / endpoints / visibility went away are
// dropped; incident edges that newly became renderable materialize.
// Non-incident edges are never touched — moving one box during a drag
// costs O(degree), not O(edges) (#236/#23a seam notes).
export const renderEdgesFor = (ids: ReadonlySet<string>): void => {
  if (!bindings || ids.size === 0) return;
  const w = must();
  const map = w.currentMap();
  const rect = cullLayerRect();
  const sel = w.selectedEdge();
  // Phase 1 — every measurement, no writes (brain#25b). The removals
  // below are writes, so they are queued rather than done inline.
  const size = makeSizeCache();
  const doomed: Array<[EdgeData, SVGGElement]> = [];
  const reroute: Array<{ e: EdgeData; g: SVGGElement; c: EdgeCoords }> = [];
  const fresh: Array<{ e: EdgeData; c: EdgeCoords }> = [];
  for (const [e, g] of edgeEls) {
    if (!ids.has(e.from) && !ids.has(e.to)) continue;
    const a = boxOf(map, e.from);
    const b = boxOf(map, e.to);
    const ea = boxEls.get(e.from);
    const eb = boxEls.get(e.to);
    if (
      // "Is this edge still in the map?" — an O(1) membership test on
      // the cull index's edge set. It used to build a Set of every
      // edge in the map on every call, i.e. O(edges) per drag frame.
      !edgeIsLive(map.boxes, map.edges, e) || !a || !b || !ea || !eb
      // An edge whose label is being typed into keeps its DOM even
      // when it pans out of range: destroying it would strand the
      // contenteditable's blur/keydown lifecycle (same rule
      // editingId() buys for boxes).
      || (rect !== null && !edgeVisible(a.x, a.y, b.x, b.y, rect)
        && editingEdge() !== e)
    ) {
      doomed.push([e, g]);
      continue;
    }
    reroute.push({ e, g, c: edgeGeometry(e, a, b, size(ea), size(eb)) });
  }
  // Only the edges actually touching `ids` — an incidence lookup off
  // the same index, so a drag frame costs O(degree) rather than a walk
  // over every edge in the map.
  for (const i of incidentEdgeIndices(map.boxes, map.edges, ids)) {
    const e = map.edges[i]!;
    if (edgeEls.has(e)) continue;
    const a = boxOf(map, e.from);
    const b = boxOf(map, e.to);
    if (!a || !b) continue;
    if (rect !== null && !edgeVisible(a.x, a.y, b.x, b.y, rect)) continue;
    const ea = boxEls.get(e.from);
    const eb = boxEls.get(e.to);
    if (!ea || !eb) continue;
    fresh.push({ e, c: edgeGeometry(e, a, b, size(ea), size(eb)) });
  }
  // Phase 2 — writes only.
  for (const [e, g] of doomed) {
    dropEdgeEls(e, g);
    if (e === appliedSelectedEdge) appliedSelectedEdge = null;
  }
  for (const r of reroute) {
    setEdgeCoords(r.g, r.c);
    syncEdgeLabel(w, r.e, r.c);
  }
  for (const f of fresh) materializeEdge(w, f.e, f.c, sel);
};

// ── Incremental per-item render (brain#238) ─────────────────────
// Bake the current interaction state onto a freshly rebuilt box
// element. renderItems preserves the appliedState snapshot (surviving
// elements keep their classes, so a full resync would be wasted work
// AND the additive resync path never *clears* — see #237's seam
// note); the one element it rebuilt must therefore arrive already
// carrying the classes/chrome the snapshot+state say it has, exactly
// like renderLines baking `selected` at build time. The trailing
// applyClasses converges the snapshot; its toggles are absolute, so
// any overlap is a no-op.
const bakeBoxState = (id: string): void => {
  const w = must();
  const el = boxEls.get(id);
  if (!el) return;
  const dropId = w.dropTargetId();
  const nearId = w.nearTargetId();
  const resizeId = resizingBoxId();
  const isSel = w.selected.has(id);
  if (isSel || id === dropId || id === nearId || id === resizeId) {
    // Fresh element: its chromed entry was dropped on removal, so
    // this attaches (grips decided from the just-baked shape classes).
    ensureBoxChrome(id);
  }
  if (isSel) el.classList.add("selected");
  if (id === dropId) {
    el.classList.add("drop-target");
    const h = w.dropTargetHandle();
    if (h !== null) toggleTargetHandle(id, h, true);
  }
  if (id === nearId) el.classList.add("proximity-target");
  if (id === resizeId) el.classList.add("resizing");
};

// Remove whatever element carries `id` (the id was deleted from the
// map). Boxes feed `touchedBoxes` so the caller drops their incident
// edge elements too.
const removeItemEls = (id: string, touchedBoxes: Set<string>): void => {
  const b = boxEls.get(id);
  if (b) {
    b.remove();
    boxEls.delete(id);
    chromed.delete(id);
    touchedBoxes.add(id);
    return;
  }
  const t = textEls.get(id);
  if (t) {
    t.remove();
    textEls.delete(id);
    return;
  }
  const img = imageEls.get(id);
  if (img) {
    img.remove();
    imageEls.delete(id);
    return;
  }
  const l = lineEls.get(id);
  if (l) {
    l.remove();
    lineEls.delete(id);
    return;
  }
  const s = strokeEls.get(id);
  if (s) {
    s.remove();
    strokeEls.delete(id);
    return;
  }
  // Nothing in the DOM claimed the id and it is gone from every layer
  // of the map, so it was a CULLED box (no element of its own, but
  // possibly materialized incident edges — a crossing edge keeps its
  // element while both endpoints are off-screen). This used to be
  // decided by a `boxById` lookup; the id set is a superset that costs
  // nothing, because renderEdgesFor only ever matches real endpoints.
  touchedBoxes.add(id);
};

// The single-item fast path: rebuild ONLY the named items' elements
// from state — create the missing, remove the deleted, recreate the
// changed in place (positioned by map order) — then re-route the
// edges incident to any touched box. Everything else in the DOM is
// untouched: classes, chrome, handlers and the appliedState snapshot
// all survive.
//
// Callers use this for every single-item mutation funnel (label edit
// commit, create/delete, palette/font/shape/size changes) AND for the
// bulk paths that add or move a KNOWN id set: clipboard paste,
// alt-drag clone, align (brain#24f). renderAll remains the fallback
// for structural changes (map switch, load, undo/redo, collab
// patches) that swap whole graph chunks.
//
// An item id that is present in the map materializes only if the cull
// pass wants it (#23a) — mutating an off-screen item leaves it
// element-less exactly like renderAll would, so a paste that lands
// outside the viewport creates no DOM at all.
export const renderItems = (ids: Iterable<string>): void => {
  const w = must();
  const map = w.currentMap();
  const g = w.graph();
  const cur = w.currentPath();
  const cull = computeCullPass(map);
  const rect = cull ? cull.rect : null;
  const touchedBoxes = new Set<string>();
  // Walk the id list BACK TO FRONT. Purely a cost optimisation for
  // bulk inserts: paste appends its items in map order, so going
  // forward every insertBefore anchor scan would run past all the
  // not-yet-created siblings (O(N²) map lookups for an N-item paste).
  // In reverse, each item's successor is already live and the scan
  // stops on its first probe. Correctness doesn't depend on the
  // direction — each anchor is computed from the live element maps.
  const list = Array.isArray(ids) ? (ids as readonly string[]) : [...ids];
  const touchedAny = list.length > 0;
  // Per-layer id → index lookups, built on first use (see indexById).
  let boxIdx: Map<string, number> | null = null;
  let textIdx: Map<string, number> | null = null;
  let imageIdx: Map<string, number> | null = null;
  let lineIdx: Map<string, number> | null = null;
  let strokeIdx: Map<string, number> | null = null;
  for (let k = list.length - 1; k >= 0; k--) {
    const id = list[k]!;
    const bi = (boxIdx ??= indexById(map.boxes)).get(id) ?? -1;
    if (bi >= 0) {
      const b = map.boxes[bi]!;
      touchedBoxes.add(id);
      const old = boxEls.get(id);
      if (old) {
        old.remove();
        boxEls.delete(id);
        chromed.delete(id);
      }
      if (boxWanted(b, cull)) {
        materializeBox(w, g, cur, b, boxAnchor(map, bi));
        bakeBoxState(id);
      }
      continue;
    }
    const ti = (textIdx ??= indexById(map.texts)).get(id) ?? -1;
    if (ti >= 0) {
      const t = map.texts[ti]!;
      const old = textEls.get(id);
      if (old) {
        old.remove();
        textEls.delete(id);
      }
      if (textWanted(t, cull)) {
        materializeText(w, t, textAnchor(map, ti));
        if (w.selected.has(id)) textEls.get(id)!.classList.add("selected");
      }
      continue;
    }
    const images = map.images ?? [];
    const ii = (imageIdx ??= indexById(images)).get(id) ?? -1;
    if (ii >= 0) {
      const im = images[ii]!;
      const old = imageEls.get(id);
      if (old) {
        old.remove();
        imageEls.delete(id);
      }
      if (imageWanted(im, cull)) {
        materializeImage(w, im, imageAnchor(map, ii));
        if (w.selected.has(id)) imageEls.get(id)!.classList.add("selected");
      }
      continue;
    }
    const li = (lineIdx ??= indexById(map.lines)).get(id) ?? -1;
    if (li >= 0) {
      const l = map.lines[li]!;
      const anchor = nextEl(map.lines, li + 1, lineEls);
      const old = lineEls.get(id);
      if (old) {
        old.remove();
        lineEls.delete(id);
      }
      if (rect === null || lineVisible(l, rect)) {
        materializeLine(w, l, anchor);
      }
      continue;
    }
    const strokes = map.strokes ?? [];
    const si = (strokeIdx ??= indexById(strokes)).get(id) ?? -1;
    if (si >= 0) {
      const s = strokes[si]!;
      const anchor = nextEl(strokes, si + 1, strokeEls);
      const old = strokeEls.get(id);
      if (old) {
        old.remove();
        strokeEls.delete(id);
      }
      if (
        s.points && s.points.length >= 2
        && (rect === null || strokeVisible(s.points, rect))
      ) {
        materializeStroke(w, s, anchor);
      }
      continue;
    }
    // Not in the map anywhere: the item was deleted.
    removeItemEls(id, touchedBoxes);
  }
  if (!touchedAny) return;
  // Batched label clamp for whatever fixed-frame boxes this pass
  // rebuilt (#258) — one flush for the whole item list.
  flushLabelClamps();
  // Elements (and possibly rendered sizes) changed for the touched
  // ids — cached rects in the proximity index are suspect.
  invalidateProximityIndex();
  // Normal diff pass (snapshot preserved): projects any state change
  // the caller made alongside the data mutation, and re-ensures
  // chrome entitlements.
  applyClasses();
  // A touched box's size/position moves its incident edge anchors;
  // a deleted box's edges are gone from the data and must drop their
  // elements. O(degree), never O(edges layer).
  if (touchedBoxes.size > 0) renderEdgesFor(touchedBoxes);
};

export const renderItem = (id: string): void => renderItems([id]);

// ── Cull refresh on pan/zoom (brain#23a) ────────────────────────
// Pan/zoom is a pure CSS transform (viewport.ts applyViewport) — no
// re-render — so viewport changes need their own materialize/recycle
// pass. updateCulling is that pass: it diffs the wanted set against
// the live element maps and touches ONLY items crossing the
// visibility boundary, leaving everything else (elements, classes,
// chrome, handlers) untouched. This is deliberately the one seam that
// adds/removes canvas elements outside renderAll — #238 (incremental
// renderAll) will generalize exactly this add/remove-by-id pattern to
// data mutations.
//
// Since #25d the pass is O(visible) end to end. It used to WALK the
// whole map to work out what was visible — which meant a 100k map paid
// 12–20 ms per pan/zoom frame before drawing anything, whatever the
// zoom. Now the wanted set comes from the spatial index (cull-index.ts)
// and the recycle pass iterates the LIVE ELEMENT MAPS, which are
// viewport-sized by construction. Neither loop touches an item that is
// neither on screen nor in the DOM.
export const updateCulling = (): void => {
  if (!bindings) return;
  const w = must();
  const map = w.currentMap();
  const cull = computeCullPass(map);
  if (!cull) return;
  lastCullRect = cull.raw;
  const g = w.graph();
  const cur = w.currentPath();
  let materialized = false;
  const images = imagesOf(map);
  const wantedBoxes = wantedBoxIndices(map, cull);
  const wantedTexts = wantedTextIndices(map, cull);
  const wantedImages = wantedImageIndices(map, cull);
  // Recycle first, materialize second. Dropping the no-longer-wanted
  // elements up front is what lets the materialize pass below take its
  // insertion anchors from the wanted list alone: after this, every
  // live element IS a wanted one, so "the nearest live element that
  // follows" and "the nearest wanted element that follows" are the
  // same thing. (The old pass could interleave the two because it
  // visited every item in map order anyway.)
  const dropUnwanted = <T extends { id: string }>(
    els: Map<string, HTMLElement>,
    items: readonly T[],
    wanted: readonly number[],
    after?: (id: string) => void,
  ): void => {
    if (els.size === 0) return;
    const keep = new Set<string>();
    for (const i of wanted) keep.add(items[i]!.id);
    for (const [id, el] of els) {
      if (keep.has(id)) continue;
      el.remove();
      els.delete(id);
      if (after) after(id);
    }
  };
  dropUnwanted(imageEls, images, wantedImages);
  dropUnwanted(textEls, map.texts, wantedTexts);
  dropUnwanted(boxEls, map.boxes, wantedBoxes, (id) => {
    // The chrome children died with the element; a stale `chromed`
    // entry would make ensureBoxChrome skip a re-materialized box.
    chromed.delete(id);
  });
  // Canvas child order is boxes → texts → images in map order, so the
  // passes run REVERSED (images first, then texts, then boxes) with a
  // running `anchor` — the nearest live element that follows in that
  // order — and every materialization inserts before it. That keeps
  // pan-in elements at their exact map position, closing the #23a
  // z-order divergence (late elements used to append at the end).
  let anchor: HTMLElement | null = null;
  for (let k = wantedImages.length - 1; k >= 0; k--) {
    const img = images[wantedImages[k]!]!;
    const el = imageEls.get(img.id);
    if (el) {
      anchor = el;
    } else {
      materializeImage(w, img, anchor);
      anchor = imageEls.get(img.id)!;
      materialized = true;
    }
  }
  for (let k = wantedTexts.length - 1; k >= 0; k--) {
    const t = map.texts[wantedTexts[k]!]!;
    const el = textEls.get(t.id);
    if (el) {
      anchor = el;
    } else {
      materializeText(w, t, anchor);
      anchor = textEls.get(t.id)!;
      materialized = true;
    }
  }
  for (let k = wantedBoxes.length - 1; k >= 0; k--) {
    const b = map.boxes[wantedBoxes[k]!]!;
    const el = boxEls.get(b.id);
    if (el) {
      anchor = el;
    } else {
      materializeBox(w, g, cur, b, anchor);
      anchor = boxEls.get(b.id)!;
      materialized = true;
    }
  }
  // Pan-in materialization is done: one measure+write pass for the
  // fixed-frame labels it queued (#258). This is the hot one — a
  // zoom step can materialize thousands of boxes in a single tick.
  flushLabelClamps();
  // Which boxes have elements (and their measured sizes) just changed.
  invalidateProximityIndex();
  // Fresh elements carry no interaction classes; resetting the
  // snapshot routes the next applyClasses through the additive resync
  // path (#237), which re-applies the live selection/drop/near/resize
  // state — O(selected) — and re-attaches chrome to entitled boxes
  // (#239). Surviving elements are already in the correct state, and
  // every resync toggle is an idempotent force-toggle, so re-touching
  // them is a no-op. This is what makes a selected box that pans back
  // in arrive with `.selected` + chrome without renderAll.
  if (materialized) {
    appliedState = null;
    applyClasses();
  }
  // SVG layers update incrementally too (#238): pan/zoom never moves
  // data coordinates, so surviving line/stroke/edge elements need
  // ZERO attribute writes — only items crossing the visibility
  // boundary are added/removed. Same reversed-iteration anchor trick
  // keeps lines/strokes in map order; edges are append-only (see
  // materializeEdge).
  cullLines(w, map, cull.rect);
  cullStrokes(w, map, cull.rect);
  cullEdges(w, map, cull);
};

// Recycle-then-materialize for one SVG layer, same shape as the canvas
// passes above: the wanted list comes from the index (O(visible)) and
// the drop pass walks the live elements (O(materialized)).
const cullLayer = <T extends { id: string }>(
  items: readonly T[],
  wanted: readonly number[],
  els: Map<string, SVGGElement>,
  make: (item: T, before: SVGGElement | null) => SVGGElement,
): void => {
  if (els.size > 0) {
    const keep = new Set<string>();
    for (const i of wanted) keep.add(items[i]!.id);
    for (const [id, el] of els) {
      if (keep.has(id)) continue;
      el.remove();
      els.delete(id);
    }
  }
  let anchor: SVGGElement | null = null;
  for (let k = wanted.length - 1; k >= 0; k--) {
    const item = items[wanted[k]!]!;
    anchor = els.get(item.id) ?? make(item, anchor);
  }
};

const cullLines = (w: RenderBindings, map: CurrentMap, rect: CullRect): void => {
  cullLayer(
    map.lines,
    visibleLineIndices(map.lines, rect),
    lineEls,
    (l, before) => materializeLine(w, l, before),
  );
};

const cullStrokes = (w: RenderBindings, map: CurrentMap, rect: CullRect): void => {
  const strokes = strokesOf(map);
  // A <2-point stroke has no path; it was never materialized and the
  // index never reports it (strokeVisible is false for it), so no
  // separate guard is needed here.
  cullLayer(
    strokes,
    visibleStrokeIndices(strokes, rect),
    strokeEls,
    (s, before) => materializeStroke(w, s, before),
  );
};

const cullEdges = (w: RenderBindings, map: CurrentMap, cull: CullPass): void => {
  const rect = cull.rect;
  const sel = w.selectedEdge();
  const doomed: Array<[EdgeData, SVGGElement]> = [];
  for (const [e, g] of edgeEls) {
    const a = boxOf(map, e.from);
    const b = boxOf(map, e.to);
    const keep =
      (a && b
        && edgeVisible(a.x, a.y, b.x, b.y, rect)
        && boxEls.has(e.from)
        && boxEls.has(e.to))
      // Never cull the edge whose label is being typed into.
      || editingEdge() === e;
    if (!keep) doomed.push([e, g]);
  }
  for (const [e, g] of doomed) dropEdgeEls(e, g);
  // Same two-phase split as renderEdges (brain#25b): measure the
  // newly-visible edges first, then build them. The candidate list was
  // already computed by computeCullPass (it is the same query that
  // decides which off-screen endpoint boxes are `required`), so this
  // pass costs O(visible edges) and re-queries nothing.
  const size = makeSizeCache();
  const fresh: Array<{ e: EdgeData; c: EdgeCoords }> = [];
  for (const i of cull.edgeIdx) {
    const e = map.edges[i]!;
    if (edgeEls.has(e)) continue;
    const a = boxOf(map, e.from);
    const b = boxOf(map, e.to);
    if (!a || !b) continue;
    const ea = boxEls.get(e.from);
    const eb = boxEls.get(e.to);
    if (!ea || !eb) continue;
    fresh.push({ e, c: edgeGeometry(e, a, b, size(ea), size(eb)) });
  }
  for (const f of fresh) materializeEdge(w, f.e, f.c, sel);
};

// How far (data px) the viewport may drift from the last evaluated
// rect before updateCulling re-runs. Must stay < CULL_MARGIN: items
// within the margin are already materialized, so evaluation lagging
// the transform by up to this much can never expose an unmaterialized
// item. Halving the margin re-culls every ~128 data px of pan travel
// instead of every frame.
const CULL_REEVAL_SLACK = CULL_MARGIN / 2;

const cullRectStale = (): boolean => {
  const raw = cullViewportRect();
  if (!raw) return false;
  const last = lastCullRect;
  if (!last) return true;
  return (
    Math.abs(raw.x1 - last.x1) > CULL_REEVAL_SLACK
    || Math.abs(raw.y1 - last.y1) > CULL_REEVAL_SLACK
    || Math.abs(raw.x2 - last.x2) > CULL_REEVAL_SLACK
    || Math.abs(raw.y2 - last.y2) > CULL_REEVAL_SLACK
  );
};

// rAF-throttled trigger, wired to viewport.ts's cull hook by main.ts.
// Fires on every applyViewport (each wheel tick / pan move / pinch
// frame) but coalesces to at most one updateCulling per frame, and
// skips entirely while the viewport is within slack of the last
// evaluation — the common case for slow pans.
let cullScheduled = false;
export const scheduleCullUpdate = (): void => {
  if (cullScheduled) return;
  cullScheduled = true;
  const run = (): void => {
    cullScheduled = false;
    // Staleness is checked at RUN time, not schedule time — the rect
    // keeps moving between the wheel event and the rAF callback.
    if (cullRectStale()) updateCulling();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
};

// Proximity highlighting: tracks which box is closest to the cursor
// during a link drag so we can hint where a new edge will land.
//
// Exported as THE link-targeting radius: findBoxAt in mouse.ts uses
// the same distance (in the same data space) for the drop cue and the
// actual drop, so the moment a box's handles appear, releasing the
// line connects to it — one radius, three cues, no disagreement.
export const PROXIMITY_PX = 60;

interface ProximityBindings {
  readonly currentMap: () => { boxes: BoxData[] };
  // handleEl is optional: applyClasses uses it to keep chrome alive on
  // the box whose handle dot carries `.active` during a link drag —
  // on a re-route pickup that box differs from fromId.
  readonly link: () => { fromId: string; handleEl?: HTMLElement } | null;
  readonly nearTargetId: () => string | null;
  readonly setNearTargetId: (id: string | null) => void;
}

let proxBindings: ProximityBindings | null = null;
const proxMust = (): ProximityBindings => {
  if (!proxBindings) throw new Error("render: wireProximity() not called");
  return proxBindings;
};

export const wireProximity = (b: ProximityBindings): void => {
  proxBindings = b;
};

// Nearest box within the link-targeting radius of a data-space point,
// via the spatial index (see proximity-index.ts) — O(cells near the
// cursor) per call instead of the old O(boxes × DOM) querySelector
// sweep. Shared by updateProximity below and findBoxAt's halo
// fallback in mouse.ts so the hover cue and the actual drop keep
// using one radius and one distance function.
export const nearestBoxId = (
  cx: number,
  cy: number,
  excludeId: string | null,
): string | null => {
  const w = proxMust();
  return nearestBoxWithin(
    w.currentMap().boxes,
    getBoxSize,
    cx,
    cy,
    PROXIMITY_PX,
    excludeId,
  );
};

export const updateProximity = (cx: number, cy: number): void => {
  const w = proxMust();
  const link = w.link();
  const best = nearestBoxId(cx, cy, link ? link.fromId : null);
  if (best !== w.nearTargetId()) {
    w.setNearTargetId(best);
    applyClasses();
  }
};

export const clearProximity = (): void => {
  const w = proxMust();
  if (w.nearTargetId() !== null) {
    w.setNearTargetId(null);
    applyClasses();
  }
};
