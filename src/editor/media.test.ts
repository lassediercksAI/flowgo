// @vitest-environment jsdom
//
// Image paste/drop → POST /media → image element on the map.
//
// Everything below the DOM event boundary is driven through the REAL
// document-level listeners media.ts installs (paste / dragover / drop),
// because the gotchas this module exists for live at that boundary:
// non-iterable DataTransferItemList, contentEditable pass-through, the
// preventDefault-or-the-browser-navigates rule. Network is mocked at
// the fetch boundary (house rule: no real requests); image decoding is
// mocked by stubbing `Image`, since jsdom never fires onload and never
// reports natural dimensions; URL.createObjectURL does not exist in
// jsdom at all, so it is stubbed and its pairing with revokeObjectURL
// is asserted (object-URL lifecycle = no leak per pasted image).
//
// Collaborator modules are mocked out:
//  - persistence.ts: SNAPSHOT_MODE is computed from location at import
//    time; a getter-backed mock lets each test choose the mode without
//    vi.resetModules gymnastics.
//  - mutations.ts / clipboard.ts: spies — media.ts's contract is "call
//    mutatedImage() after landing an image" and "fall back to
//    pasteSelection() when the OS clipboard has no image".
// viewport.ts is real: it is a pure coordinate transform over an
// exported mutable object, so tests just set viewport.{x,y,s}.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshot: { value: false },
  mutatedImage: vi.fn(),
  pasteSelection: vi.fn(),
}));

vi.mock("./persistence.ts", () => ({
  get SNAPSHOT_MODE() {
    return mocks.snapshot.value;
  },
}));
vi.mock("./mutations.ts", () => ({ mutatedImage: mocks.mutatedImage }));
vi.mock("./clipboard.ts", () => ({ pasteSelection: mocks.pasteSelection }));

import {
  attachMediaListeners,
  imageBlobsFromFiles,
  imageBlobsFromItems,
  scaledInsertSize,
  wireMedia,
} from "./media.ts";
import { viewport } from "./viewport.ts";

// ---------------------------------------------------------------
// Test doubles.
// ---------------------------------------------------------------

interface ImageItem {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// What the next `new Image()` decode reports. fail → onerror.
let nextDecode: { nw: number; nh: number; fail?: boolean };

// jsdom's Image never loads anything; this fake resolves on a
// microtask so measure()'s promise settles under real timers.
class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => {
      if (nextDecode.fail) {
        this.onerror?.();
        return;
      }
      this.naturalWidth = nextDecode.nw;
      this.naturalHeight = nextDecode.nh;
      this.onload?.();
    });
  }
}

let fetchCalls: Array<{ url: string; init: RequestInit }>;
let fetchImpl: () => Promise<unknown>;
const okUpload = (src = "flowgo-media/abc123.png") => () =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ src }) });

let map: { images?: ImageItem[] };
let status: string[];
let selected: Set<string>;
let clearSelectedEdge: ReturnType<typeof vi.fn<() => void>>;
let renderAll: ReturnType<typeof vi.fn<() => void>>;
let createdUrls: number;
let revokedUrls: string[];

// insertImage hops fetch → json → measure; a few macrotask turns
// flushes every interleaving of parallel inserts.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

// Deliberately array-like but NOT iterable (no Symbol.iterator):
// DataTransferItemList lacks one in several engines, and media.ts
// documents "never for..of these". A regression to for..of throws
// here and fails the test instead of shipping.
const arrayLike = <T,>(...entries: T[]): Record<string, unknown> => {
  const list: Record<string, unknown> = { length: entries.length };
  entries.forEach((e, i) => {
    list[i] = e;
  });
  return list;
};

// Shape of a DataTransferItem as far as media.ts reads it.
interface FakeItem {
  kind: string;
  type: string;
  getAsFile: () => Blob | null;
}

const fileItem = (blob: Blob): FakeItem => ({
  kind: "file",
  type: blob.type,
  getAsFile: () => blob,
});

const png = (): File => new File(["x"], "a.png", { type: "image/png" });

const dispatchPaste = (
  clipboardData: unknown,
  target: EventTarget = document,
): Event => {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: clipboardData });
  target.dispatchEvent(e);
  return e;
};

const dispatchDrop = (
  dataTransfer: unknown,
  clientX: number,
  clientY: number,
  target: EventTarget = document,
): Event => {
  const e = new Event("drop", { bubbles: true, cancelable: true });
  Object.assign(e, { clientX, clientY });
  Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(e);
  return e;
};

const dispatchDragOver = (target: EventTarget = document): Event => {
  const e = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", {
    value: { dropEffect: "none" },
    writable: false,
  });
  target.dispatchEvent(e);
  return e;
};

// Listeners survive on `document` for the life of the file (module
// installs them once; there is no detach API — module-level state).
attachMediaListeners();

beforeEach(() => {
  mocks.snapshot.value = false;
  mocks.mutatedImage.mockReset();
  mocks.pasteSelection.mockReset();

  nextDecode = { nw: 800, nh: 600 };
  vi.stubGlobal("Image", FakeImage);

  fetchCalls = [];
  fetchImpl = okUpload();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      fetchCalls.push({ url, init });
      return fetchImpl();
    }),
  );

  createdUrls = 0;
  revokedUrls = [];
  URL.createObjectURL = vi.fn(() => `blob:fake-${++createdUrls}`);
  URL.revokeObjectURL = vi.fn((u: string) => void revokedUrls.push(u));

  // Failure paths intentionally console.error (the status bar is gone);
  // keep the runner output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});

  // viewport is a shared mutable module object — reset it explicitly.
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;

  map = {};
  status = [];
  selected = new Set(["previous-selection"]);
  clearSelectedEdge = vi.fn<() => void>();
  renderAll = vi.fn<() => void>();
  let n = 0;
  wireMedia({
    canvas: document.createElement("div"),
    currentMap: () => map,
    mintId: (prefix) => `${prefix}-${++n}`,
    lastCursor: { x: 100, y: 60 },
    selected,
    clearSelectedEdge,
    renderAll,
    setStatus: (s) => status.push(s),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------

describe("scaledInsertSize", () => {
  it("caps the longest side at 480 preserving aspect", () => {
    expect(scaledInsertSize(800, 600)).toEqual({ width: 480, height: 360 });
    expect(scaledInsertSize(600, 800)).toEqual({ width: 360, height: 480 });
    expect(scaledInsertSize(960, 480)).toEqual({ width: 480, height: 240 });
  });

  it("never upscales a small image", () => {
    // A 100×50 sticker must land at natural size; blowing it up to
    // 480 would pixelate every small paste.
    expect(scaledInsertSize(100, 50)).toEqual({ width: 100, height: 50 });
    expect(scaledInsertSize(480, 480)).toEqual({ width: 480, height: 480 });
  });

  it("rounds to whole pixels", () => {
    // 1000×333 → scale 0.48 → 159.84 rounds to 160.
    expect(scaledInsertSize(1000, 333)).toEqual({ width: 480, height: 160 });
  });

  it("falls back to a 300px square when dimensions are unreadable", () => {
    // Some SVGs report 0×0; the element must still be selectable.
    expect(scaledInsertSize(0, 0)).toEqual({ width: 300, height: 300 });
    expect(scaledInsertSize(0, 600)).toEqual({ width: 300, height: 300 });
    expect(scaledInsertSize(-1, 5)).toEqual({ width: 300, height: 300 });
  });
});

describe("blob extraction (array-like, never for..of)", () => {
  it("keeps only file-kind image items", () => {
    const img = png();
    const items = arrayLike<FakeItem>(
      { kind: "string", type: "text/plain", getAsFile: () => null },
      fileItem(img),
      {
        kind: "file",
        type: "application/pdf",
        getAsFile: () => new File([""], "d.pdf", { type: "application/pdf" }),
      },
    );
    expect(imageBlobsFromItems(items as unknown as DataTransferItemList)).toEqual([img]);
  });

  it("skips a file item whose getAsFile returns null", () => {
    const items = arrayLike<FakeItem>({
      kind: "file",
      type: "image/png",
      getAsFile: () => null,
    });
    expect(imageBlobsFromItems(items as unknown as DataTransferItemList)).toEqual([]);
  });

  it("tolerates null/undefined lists", () => {
    expect(imageBlobsFromItems(null)).toEqual([]);
    expect(imageBlobsFromItems(undefined)).toEqual([]);
    expect(imageBlobsFromFiles(null)).toEqual([]);
  });

  it("filters non-image files from a FileList", () => {
    const img = png();
    const files = arrayLike(new File(["t"], "n.txt", { type: "text/plain" }), img);
    expect(imageBlobsFromFiles(files as unknown as FileList)).toEqual([img]);
  });
});

// ---------------------------------------------------------------
// Paste → upload → placement.
// ---------------------------------------------------------------

describe("paste of an OS-clipboard image", () => {
  it("uploads to POST /media with the blob's content type", async () => {
    const img = png();
    dispatchPaste({ items: arrayLike(fileItem(img)) });
    await flush();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("/media");
    expect(fetchCalls[0]!.init.method).toBe("POST");
    expect(fetchCalls[0]!.init.headers).toEqual({ "Content-Type": "image/png" });
    expect(fetchCalls[0]!.init.body).toBe(img);
  });

  it("lands a scaled image centred on the cursor, selected, mutated, rendered", async () => {
    // lastCursor (100,60) at identity viewport → data (100,60);
    // 800×600 scales to 480×360 → top-left (100-240, 60-180).
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(map.images).toEqual([
      {
        id: "img-1",
        src: "flowgo-media/abc123.png",
        x: -140,
        y: -120,
        width: 480,
        height: 360,
      },
    ]);
    // Selection swaps to the new image — the user's next keystroke
    // (delete, arrows) must act on what they just pasted.
    expect([...selected]).toEqual(["img-1"]);
    expect(clearSelectedEdge).toHaveBeenCalled();
    expect(mocks.mutatedImage).toHaveBeenCalledTimes(1);
    expect(renderAll).toHaveBeenCalledTimes(1);
    expect(status).toEqual(["uploading image…", "image added"]);
  });

  it("prevents the browser default when it takes the paste", () => {
    const e = dispatchPaste({ items: arrayLike(fileItem(png())) });
    expect(e.defaultPrevented).toBe(true);
  });

  it("cascades multiple pasted images by 20px so they don't stack", async () => {
    dispatchPaste({ items: arrayLike(fileItem(png()), fileItem(png())) });
    await flush();
    expect(map.images).toHaveLength(2);
    const [a, b] = map.images!;
    expect(b!.x - a!.x).toBe(20);
    expect(b!.y - a!.y).toBe(20);
    expect(a!.id).not.toBe(b!.id);
  });

  it("falls back to clipboardData.files when items yields nothing", async () => {
    // Some browsers populate only .files for a pasted screenshot.
    dispatchPaste({ items: arrayLike(), files: arrayLike(png()) });
    await flush();
    expect(fetchCalls).toHaveLength(1);
    expect(map.images).toHaveLength(1);
  });

  it("routes a no-image paste to the internal clipboard buffer", () => {
    const e = dispatchPaste({ items: arrayLike(), files: arrayLike() });
    expect(mocks.pasteSelection).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
    // Still prevented: flowgo owns the paste either way.
    expect(e.defaultPrevented).toBe(true);
  });

  it("handles a null clipboardData without exploding", () => {
    dispatchPaste(null);
    expect(mocks.pasteSelection).toHaveBeenCalledTimes(1);
  });

  it("leaves a paste into an active label edit to the browser", () => {
    // jsdom does not implement isContentEditable, so pin the flag the
    // handler actually reads.
    const editing = document.createElement("div");
    Object.defineProperty(editing, "isContentEditable", { value: true });
    document.body.appendChild(editing);
    const e = dispatchPaste({ items: arrayLike(fileItem(png())) }, editing);
    expect(e.defaultPrevented).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    expect(mocks.pasteSelection).not.toHaveBeenCalled();
    editing.remove();
  });
});

describe("image sizing on insert", () => {
  it("uses the fallback square when decode reports no dimensions", async () => {
    nextDecode = { nw: 0, nh: 0 };
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(map.images![0]).toMatchObject({ width: 300, height: 300 });
  });

  it("uses the fallback square when the image errors during decode", async () => {
    nextDecode = { nw: 0, nh: 0, fail: true };
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(map.images![0]).toMatchObject({ width: 300, height: 300 });
  });

  it("revokes every object URL it creates (load and error paths)", async () => {
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    nextDecode = { nw: 0, nh: 0, fail: true };
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(createdUrls).toBe(2);
    expect(revokedUrls).toEqual(["blob:fake-1", "blob:fake-2"]);
  });
});

// ---------------------------------------------------------------
// Failure paths — what must NOT land in the graph.
// ---------------------------------------------------------------

describe("upload failures", () => {
  it("non-200 → status + console.error, nothing added, no mutation", async () => {
    fetchImpl = () =>
      Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(status).toEqual(["uploading image…", "image upload failed: HTTP 500"]);
    expect(map.images).toBeUndefined();
    expect(mocks.mutatedImage).not.toHaveBeenCalled();
    expect(renderAll).not.toHaveBeenCalled();
    // The status bar is gone from the product; console is the only
    // place a failed paste is visible.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("POST /media"),
      expect.anything(),
    );
  });

  it("network error → surfaced message, nothing added", async () => {
    fetchImpl = () => Promise.reject(new Error("network down"));
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(status).toContain("image upload failed: network down");
    expect(map.images).toBeUndefined();
    expect(mocks.mutatedImage).not.toHaveBeenCalled();
  });

  it("2xx with no src in the body is a failure, not a broken image", async () => {
    fetchImpl = () =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(status).toContain("image upload failed: response missing src");
    expect(map.images).toBeUndefined();
  });
});

describe("snapshot (shared-view) mode", () => {
  it("announces unavailability and makes NO network call", async () => {
    // /m/<id> pages have no filesystem behind them; a POST /media
    // would 404 against the website origin.
    mocks.snapshot.value = true;
    dispatchPaste({ items: arrayLike(fileItem(png())) });
    await flush();
    expect(fetchCalls).toHaveLength(0);
    expect(status).toEqual(["image paste unavailable in shared view"]);
    expect(map.images).toBeUndefined();
    expect(mocks.mutatedImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Drag & drop.
// ---------------------------------------------------------------

describe("drop", () => {
  it("inserts at the drop point translated through the viewport", async () => {
    viewport.x = 50;
    viewport.y = 20;
    viewport.s = 2;
    // client (150,120) → data ((150-50)/2, (120-20)/2) = (50,50).
    dispatchDrop({ files: arrayLike(png()) }, 150, 120);
    await flush();
    expect(map.images![0]).toMatchObject({ x: 50 - 240, y: 50 - 180 });
  });

  it("preventDefaults even a non-image drop so the browser never navigates", () => {
    const e = dispatchDrop(
      { files: arrayLike(new File(["t"], "n.txt", { type: "text/plain" })) },
      10,
      10,
    );
    expect(e.defaultPrevented).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it("ignores a drop onto an active label edit", () => {
    const editing = document.createElement("div");
    Object.defineProperty(editing, "isContentEditable", { value: true });
    document.body.appendChild(editing);
    const e = dispatchDrop({ files: arrayLike(png()) }, 10, 10, editing);
    expect(e.defaultPrevented).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    editing.remove();
  });
});

describe("dragover", () => {
  it("claims the drag (preventDefault + copy effect) so drop can fire", () => {
    const e = dispatchDragOver();
    expect(e.defaultPrevented).toBe(true);
    expect((e as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe("copy");
  });

  it("lets a drag over an active label edit through", () => {
    const editing = document.createElement("div");
    Object.defineProperty(editing, "isContentEditable", { value: true });
    document.body.appendChild(editing);
    const e = dispatchDragOver(editing);
    expect(e.defaultPrevented).toBe(false);
    editing.remove();
  });
});
