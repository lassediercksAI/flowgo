// Image assets: paste-from-clipboard and drag-and-drop of image files
// onto the canvas. The binary is uploaded to the local server's
// POST /media endpoint, which content-addresses it into the
// flowgo-media/ folder next to the .flowgo file and returns a relative
// `src`. We then drop an image element on the current map at the
// cursor / drop point.
//
// Local (CLI) mode only: in shared-snapshot mode (/m/<id>) there's no
// filesystem to write to, so paste/drop are announced as unavailable
// and make no network call.

import { toDataX, toDataY } from "./viewport.ts";
import { mutatedImage } from "./mutations.ts";
import { SNAPSHOT_MODE } from "./persistence.ts";
import { pasteSelection } from "./clipboard.ts";

interface ImageItem {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CurrentMap {
  images?: ImageItem[];
}

interface MediaBindings {
  readonly canvas: HTMLElement;
  readonly currentMap: () => CurrentMap;
  readonly mintId: (prefix: string) => string;
  readonly lastCursor: { x: number; y: number };
  readonly selected: Set<string>;
  readonly clearSelectedEdge: () => void;
  readonly renderAll: () => void;
  readonly setStatus: (s: string) => void;
}

// Longest side an inserted image is scaled to on first drop, preserving
// aspect. Keeps a phone screenshot from carpeting the whole canvas; the
// user can resize up afterwards via the corner grip.
const MAX_INSERT_PX = 480;
// Fallback size when the browser can't report natural dimensions (e.g.
// some SVGs), so the element is still selectable and resizable.
const FALLBACK_PX = 300;

let bindings: MediaBindings | null = null;
const must = (): MediaBindings => {
  if (!bindings) throw new Error("media: wireMedia() not called");
  return bindings;
};

export const wireMedia = (b: MediaBindings): void => {
  bindings = b;
};

// POST the blob to the local media endpoint; resolves to the relative
// `src` the .flowgo file references (e.g. "flowgo-media/<hash>.png").
const uploadBlob = async (blob: Blob): Promise<string> => {
  const r = await fetch("/media", {
    method: "POST",
    headers: { "Content-Type": blob.type },
    body: blob,
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const body = (await r.json()) as { src?: string };
  if (!body.src) throw new Error("response missing src");
  return body.src;
};

// Pure: natural dimensions → insert size. Longest side capped at
// MAX_INSERT_PX (never upscaled past natural size); non-positive or
// unreadable dimensions collapse to the FALLBACK_PX square. Exported
// so the scaling contract is testable without decoding a real image.
export const scaledInsertSize = (
  nw: number,
  nh: number,
): { width: number; height: number } => {
  if (nw <= 0 || nh <= 0) {
    return { width: FALLBACK_PX, height: FALLBACK_PX };
  }
  const scale = Math.min(1, MAX_INSERT_PX / Math.max(nw, nh));
  return {
    width: Math.round(nw * scale),
    height: Math.round(nh * scale),
  };
};

// Read natural dimensions from the blob, scaled so the longest side is
// at most MAX_INSERT_PX. Falls back to a square when the browser can't
// decode a size.
const measure = (blob: Blob): Promise<{ width: number; height: number }> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      resolve(scaledInsertSize(im.naturalWidth || 0, im.naturalHeight || 0));
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: FALLBACK_PX, height: FALLBACK_PX });
    };
    im.src = url;
  });

// Upload + place a single image centred on (cx, cy) in data coords.
const insertImage = async (
  blob: Blob,
  cx: number,
  cy: number,
): Promise<void> => {
  const w = must();
  if (SNAPSHOT_MODE) {
    w.setStatus("image paste unavailable in shared view");
    console.info("flowgo: image paste is unavailable in shared (snapshot) view");
    return;
  }
  w.setStatus("uploading image…");
  let src: string;
  try {
    src = await uploadBlob(blob);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    w.setStatus("image upload failed: " + msg);
    // The status bar was removed, so surface failures where they can be
    // seen — otherwise a paste just silently does nothing.
    console.error("flowgo: image upload failed (POST /media): " + msg, err);
    return;
  }
  const { width, height } = await measure(blob);
  const map = w.currentMap();
  if (!map.images) map.images = [];
  const id = w.mintId("img");
  const item: ImageItem = {
    id,
    src,
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  };
  map.images.push(item);
  w.selected.clear();
  w.selected.add(id);
  w.clearSelectedEdge();
  mutatedImage();
  w.renderAll();
  w.setStatus("image added");
};

// DataTransferItemList and FileList are array-like but NOT reliably
// iterable with `for...of` across browsers — DataTransferItemList in
// particular has no Symbol.iterator in several engines, so a `for..of`
// throws and silently kills the paste handler. Always index by
// .length / [i] instead.

// Exported for tests: pure over an array-like of clipboard items.
export const imageBlobsFromItems = (
  items: DataTransferItemList | null | undefined,
): Blob[] => {
  const out: Blob[] = [];
  if (!items) return out;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
};

// Exported for tests: pure over an array-like of dropped/pasted files.
export const imageBlobsFromFiles = (
  files: FileList | null | undefined,
): Blob[] => {
  const out: Blob[] = [];
  if (!files) return out;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f && f.type.startsWith("image/")) out.push(f);
  }
  return out;
};

const onPaste = (e: ClipboardEvent): void => {
  // Let the browser handle paste into an active label edit.
  const target = e.target as HTMLElement | null;
  if (target && target.isContentEditable) return;
  const cd = e.clipboardData;
  // Prefer items (works for screenshots + copied images); fall back to
  // clipboardData.files for browsers that populate only that.
  let blobs = imageBlobsFromItems(cd?.items);
  if (blobs.length === 0) blobs = imageBlobsFromFiles(cd?.files);
  e.preventDefault();
  if (blobs.length === 0) {
    // No image on the OS clipboard → paste flowgo's internal buffer
    // (boxes / texts / lines / images copied in-app). This is the sole
    // paste path now; keys.ts no longer intercepts Cmd/Ctrl+V so this
    // event fires and can read clipboard images.
    pasteSelection();
    return;
  }
  const w = must();
  const cx = toDataX(w.lastCursor.x);
  const cy = toDataY(w.lastCursor.y);
  blobs.forEach((b, i) => void insertImage(b, cx + i * 20, cy + i * 20));
};

const onDragOver = (e: DragEvent): void => {
  const target = e.target as HTMLElement | null;
  if (target && target.isContentEditable) return; // allow text drop into a label edit
  // dragover MUST preventDefault or the browser refuses the drop and
  // opens the dragged file instead.
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  e.preventDefault();
};

const onDrop = (e: DragEvent): void => {
  const target = e.target as HTMLElement | null;
  if (target && target.isContentEditable) return;
  // Stop the browser from navigating to the dropped file, whether or
  // not it turns out to be an image we handle.
  e.preventDefault();
  const blobs = imageBlobsFromFiles(e.dataTransfer?.files);
  if (blobs.length === 0) return;
  const cx = toDataX(e.clientX);
  const cy = toDataY(e.clientY);
  blobs.forEach((b, i) => void insertImage(b, cx + i * 20, cy + i * 20));
};

export const attachMediaListeners = (): void => {
  document.addEventListener("paste", onPaste);
  // Listen at the document level: a drop can land on any layer — the
  // background grid, the SVG edge/line overlays, a box — not just
  // #canvas. Anywhere we don't preventDefault, the browser opens the
  // file, so the interception has to be document-wide.
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);
};
