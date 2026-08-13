// @vitest-environment jsdom
//
// Inline label editing (edit.ts): the beginInlineEdit lifecycle across
// its three flavours (text items, boxes, edge labels), driven through
// the REAL contenteditable focus/blur/keydown wiring — jsdom implements
// the contenteditable attribute, focus(), blur() and Selection, which
// is exactly the surface edit.ts confines itself to.
//
// What jsdom cannot supply: innerText (undefined here, so the
// textContent fallback runs) and real caret painting. The innerText
// preference is pinned by defining the property explicitly on one
// fixture; caret behaviour is pinned at the Selection level (which
// element's contents the initial range spans), not at pixel level.
//
// normalizeLabel itself is covered in src/graph/label.test — these
// tests only pin that edit.ts routes reads through it.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  commitEdgeLabelEdit,
  editingEdge,
  editingId,
  isEditing,
  pruneMapsUnder,
  spawnedBoxMapPath,
  startEdgeLabelEdit,
  startEdit,
  startTextEdit,
  wireEdit,
} from "./edit.ts";
import { wireMutations } from "./mutations.ts";
import { MAX_LABEL_LEN } from "../graph/label.ts";

// ── fixtures / harness ──────────────────────────────────────────────

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
}
interface EdgeRec {
  from: string;
  to: string;
  label?: string | undefined;
}

let canvas: HTMLElement;
let map: { boxes: BoxLike[]; edges: { from: string; to: string }[] };
let graph: { maps: { path: string }[] };
let currentPath = "/";
const selected = new Set<string>();
let statuses: string[] = [];
let renderItemCalls: string[] = [];
let renderAllCalls = 0;
let renderEdgeLabelCalls = 0;
let saves = 0;
let mutationKinds: string[] = [];
// Swappable so the missing-label recovery test can make renderAll
// actually rebuild the box element.
let renderAllImpl: () => void = () => {};

let listenerError: unknown = null;

beforeAll(() => {
  // jsdom swallows exceptions thrown inside event listeners into a
  // window "error" event; trap it so a throwing blur/keydown handler
  // fails the test instead of passing silently.
  window.addEventListener("error", (e) => {
    listenerError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
    e.preventDefault();
  });
});

// edit.ts keeps the live editor in module state. Escape is the
// module's own abort hatch: dispatching it on whatever contenteditable
// a failed test left behind clears `editing` without committing.
const abortAnyEdit = (): void => {
  const live = document.querySelector<HTMLElement>('[contenteditable="true"]');
  if (live) key(live, "Escape");
};

beforeEach(() => {
  abortAnyEdit();
  document.body.innerHTML = "";
  canvas = document.createElement("div");
  canvas.id = "canvas";
  document.body.appendChild(canvas);
  map = { boxes: [], edges: [] };
  graph = { maps: [{ path: "/" }] };
  currentPath = "/";
  selected.clear();
  statuses = [];
  renderItemCalls = [];
  renderAllCalls = 0;
  renderEdgeLabelCalls = 0;
  saves = 0;
  mutationKinds = [];
  renderAllImpl = () => {};
  listenerError = null;

  wireMutations({
    scheduleSave: () => {
      saves++;
    },
    onMutate: (e) => {
      mutationKinds.push(e.kind);
    },
  });
  wireEdit({
    canvas,
    getCurrentMap: () => map,
    setCurrentMap: (m) => {
      map = m;
    },
    getCurrentPath: () => currentPath,
    getGraph: () => graph,
    setGraph: (g) => {
      graph = g;
    },
    ensureMap: () => map,
    selected,
    renderAll: () => {
      renderAllCalls++;
      renderAllImpl();
    },
    renderItem: (id) => {
      renderItemCalls.push(id);
    },
    renderEdgeLabels: () => {
      renderEdgeLabelCalls++;
    },
    setStatus: (s) => {
      statuses.push(s);
    },
  });
});

afterEach(() => {
  expect(listenerError).toBeNull();
  // Every test must end its own edit — a leaked one would wedge the
  // next test's beginInlineEdit guard.
  expect(isEditing()).toBe(false);
});

const key = (el: HTMLElement, k: string, shift = false): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", {
    key: k,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(e);
  return e;
};

const makeTextEl = (id: string): HTMLElement => {
  const el = document.createElement("div");
  el.className = "text-item";
  el.dataset["id"] = id;
  canvas.appendChild(el);
  return el;
};

const makeBoxEl = (b: BoxLike): HTMLElement => {
  const el = document.createElement("div");
  el.className = "box";
  el.dataset["id"] = b.id;
  const span = document.createElement("span");
  span.className = "box-label";
  span.textContent = b.label;
  el.appendChild(span);
  canvas.appendChild(el);
  return el;
};

const makeEdgeLabelEl = (): HTMLElement => {
  const el = document.createElement("div");
  el.className = "edge-label";
  canvas.appendChild(el);
  return el;
};

// ── text items ──────────────────────────────────────────────────────

describe("startTextEdit", () => {
  it("claims the editing flag, seeds, focuses and selects the contents", () => {
    const t = { id: "t1", label: "hello", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    expect(isEditing()).toBe(false);
    expect(editingId()).toBeNull();

    startTextEdit(el, t);
    expect(isEditing()).toBe(true);
    expect(editingId()).toBe("t1");
    expect(el.getAttribute("contenteditable")).toBe("true");
    expect(el.textContent).toBe("hello");
    expect(document.activeElement).toBe(el);
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    // Caret pin without layout: the initial range spans the host's
    // whole contents (select-all on entry).
    const r = sel.getRangeAt(0);
    expect(r.startContainer).toBe(el);
    expect(r.startOffset).toBe(0);
    expect(r.endOffset).toBe(el.childNodes.length);

    key(el, "Escape");
  });

  it("Enter commits a changed label, dirties as a text mutation, tears down", () => {
    const t = { id: "t1", label: "old", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.textContent = "new label";
    const e = key(el, "Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(t.label).toBe("new label");
    expect(saves).toBe(1);
    expect(mutationKinds).toEqual(["text"]);
    expect(isEditing()).toBe(false);
    expect(editingId()).toBeNull();
    expect(el.getAttribute("contenteditable")).toBe("false");
    expect(el.textContent).toBe("new label");
  });

  it("Escape reverts: model untouched, DOM restored, nothing saved", () => {
    const t = { id: "t1", label: "old", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.textContent = "typed but discarded";
    const e = key(el, "Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(t.label).toBe("old");
    expect(saves).toBe(0);
    expect(el.textContent).toBe("old");
    expect(isEditing()).toBe(false);
  });

  it("blur commits, same as Enter", () => {
    const t = { id: "t1", label: "old", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.textContent = "via blur";
    el.blur();
    expect(t.label).toBe("via blur");
    expect(saves).toBe(1);
    expect(isEditing()).toBe(false);
  });

  it("an emptied text item keeps its old label (empty commit is dropped)", () => {
    const t = { id: "t1", label: "keep me", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.textContent = "";
    el.blur();
    expect(t.label).toBe("keep me");
    expect(saves).toBe(0);
    // done() always writes the model back, so the emptied DOM heals.
    expect(el.textContent).toBe("keep me");
  });

  it("a whitespace-only commit normalizes to empty and is dropped too", () => {
    const t = { id: "t1", label: "keep me", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.textContent = "   \n\t  ";
    el.blur();
    expect(t.label).toBe("keep me");
    expect(saves).toBe(0);
  });

  it("committing the unchanged label does not dirty the doc", () => {
    const t = { id: "t1", label: "same", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.blur();
    expect(t.label).toBe("same");
    expect(saves).toBe(0);
  });

  it("the committed label goes through normalizeLabel", () => {
    const t = { id: "t1", label: "old", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.textContent = "  a\t   b  ";
    el.blur();
    expect(t.label).toBe("a b");
    expect(saves).toBe(1);
  });

  it("Shift+Enter is left to the browser: no commit, not prevented", () => {
    const t = { id: "t1", label: "old", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    const e = key(el, "Enter", true);
    expect(e.defaultPrevented).toBe(false);
    expect(isEditing()).toBe(true);
    key(el, "Escape");
  });

  it("innerText is preferred over textContent on read-back", () => {
    // jsdom has no innerText, so supply one that differs from
    // textContent: the module must read the one that preserves the
    // Shift+Enter line breaks.
    const t = { id: "t1", label: "old", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    el.textContent = "flat";
    Object.defineProperty(el, "innerText", {
      configurable: true,
      get: () => "line1\nline2",
    });
    el.blur();
    expect(t.label).toBe("line1\nline2");
  });

  it("keystrokes are fenced off from document-level shortcut handlers", () => {
    const t = { id: "t1", label: "old", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    let leaked = 0;
    const spy = (): void => {
      leaked++;
    };
    document.addEventListener("keydown", spy);
    key(el, "a");
    key(el, "Enter", true);
    document.removeEventListener("keydown", spy);
    expect(leaked).toBe(0);
    expect(isEditing()).toBe(true);
    key(el, "Escape");
  });

  it("refuses to start while another edit is live", () => {
    const t1 = { id: "t1", label: "one", x: 0, y: 0 };
    const t2 = { id: "t2", label: "two", x: 0, y: 0 };
    const el1 = makeTextEl(t1.id);
    const el2 = makeTextEl(t2.id);
    startTextEdit(el1, t1);
    startTextEdit(el2, t2);
    expect(editingId()).toBe("t1");
    expect(el2.hasAttribute("contenteditable")).toBe(false);
    // t2 was not seeded — proof the second call bailed before seed().
    expect(el2.textContent).toBe("");
    key(el1, "Escape");
  });
});

// ── edge labels ─────────────────────────────────────────────────────

describe("startEdgeLabelEdit", () => {
  it("exposes the edge under edit and seeds the existing label", () => {
    const e: EdgeRec = { from: "a", to: "b", label: "was" };
    const el = makeEdgeLabelEl();
    expect(editingEdge()).toBeNull();
    startEdgeLabelEdit(el, e);
    expect(editingEdge()).toBe(e);
    expect(el.textContent).toBe("was");
    key(el, "Escape");
    expect(editingEdge()).toBeNull();
  });

  it("does not leak the edge ref when another edit already holds the flag", () => {
    const t = { id: "t1", label: "x", x: 0, y: 0 };
    const tEl = makeTextEl(t.id);
    startTextEdit(tEl, t);
    const e: EdgeRec = { from: "a", to: "b", label: "was" };
    const el = makeEdgeLabelEl();
    startEdgeLabelEdit(el, e);
    // Bailed before seed(): no ref, no DOM write.
    expect(editingEdge()).toBeNull();
    expect(el.textContent).toBe("");
    key(tEl, "Escape");
  });

  it("commit writes the label, dirties as an edge mutation, refreshes the layer", () => {
    const e: EdgeRec = { from: "a", to: "b", label: "was" };
    const el = makeEdgeLabelEl();
    startEdgeLabelEdit(el, e);
    el.textContent = "now";
    el.blur();
    expect(e.label).toBe("now");
    expect(saves).toBe(1);
    expect(mutationKinds).toEqual(["edge"]);
    expect(renderEdgeLabelCalls).toBe(1);
    expect(editingEdge()).toBeNull();
  });

  it("an empty commit REMOVES the label (field deleted, not set to '')", () => {
    const e: EdgeRec = { from: "a", to: "b", label: "was" };
    const el = makeEdgeLabelEl();
    startEdgeLabelEdit(el, e);
    el.textContent = "";
    el.blur();
    expect("label" in e).toBe(false);
    expect(saves).toBe(1);
    expect(renderEdgeLabelCalls).toBe(1);
  });

  it("an empty commit on an unlabelled edge changes nothing", () => {
    const e: EdgeRec = { from: "a", to: "b" };
    const el = makeEdgeLabelEl();
    startEdgeLabelEdit(el, e);
    el.blur();
    expect("label" in e).toBe(false);
    expect(saves).toBe(0);
    // The layer still refreshes: the renderer created this element on
    // demand and must get the chance to drop it again.
    expect(renderEdgeLabelCalls).toBe(1);
  });

  it("Escape reverts the label but still refreshes the layer", () => {
    const e: EdgeRec = { from: "a", to: "b", label: "was" };
    const el = makeEdgeLabelEl();
    startEdgeLabelEdit(el, e);
    el.textContent = "typed";
    key(el, "Escape");
    expect(e.label).toBe("was");
    expect(saves).toBe(0);
    expect(renderEdgeLabelCalls).toBe(1);
  });

  it("commitEdgeLabelEdit commits an in-flight edge edit (render.ts hook)", () => {
    const e: EdgeRec = { from: "a", to: "b", label: "was" };
    const el = makeEdgeLabelEl();
    startEdgeLabelEdit(el, e);
    el.textContent = "committed by renderer";
    commitEdgeLabelEdit();
    expect(e.label).toBe("committed by renderer");
    expect(isEditing()).toBe(false);
    expect(editingEdge()).toBeNull();
  });

  it("commitEdgeLabelEdit leaves box/text edits alone", () => {
    const t = { id: "t1", label: "x", x: 0, y: 0 };
    const el = makeTextEl(t.id);
    startTextEdit(el, t);
    commitEdgeLabelEdit();
    expect(isEditing()).toBe(true);
    key(el, "Escape");
  });

  it("commitEdgeLabelEdit is a no-op when nothing is being edited", () => {
    expect(() => commitEdgeLabelEdit()).not.toThrow();
    expect(saves).toBe(0);
  });
});

// ── boxes ───────────────────────────────────────────────────────────

describe("startEdit (box)", () => {
  const addBox = (
    id: string,
    label: string,
  ): { b: BoxLike; el: HTMLElement } => {
    const b: BoxLike = { id, label, x: 0, y: 0 };
    map.boxes.push(b);
    return { b, el: makeBoxEl(b) };
  };

  it("selects the .box-label span's contents, not the whole box element", () => {
    const { b, el } = addBox("b1", "hello");
    startEdit(el, b);
    const labelEl = el.querySelector<HTMLElement>(".box-label")!;
    expect(labelEl.textContent).toBe("hello");
    const r = window.getSelection()!.getRangeAt(0);
    // Caret pin: the range spans the label span (caretTarget), while
    // the host — svg polygon, handles and all — stays outside it.
    expect(r.startContainer).toBe(labelEl);
    expect(editingId()).toBe("b1");
    key(el, "Escape");
  });

  it("Enter commit updates the label and rebuilds only that box", () => {
    const { b, el } = addBox("b1", "old");
    startEdit(el, b);
    el.querySelector(".box-label")!.textContent = "new";
    key(el, "Enter");
    expect(b.label).toBe("new");
    expect(saves).toBe(1);
    expect(mutationKinds).toEqual(["box"]);
    expect(renderItemCalls).toEqual(["b1"]);
    expect(renderAllCalls).toBe(0);
    expect(isEditing()).toBe(false);
  });

  it("an emptied box keeps its old label and is NOT deleted", () => {
    const { b, el } = addBox("b1", "keep me");
    startEdit(el, b);
    el.querySelector(".box-label")!.textContent = "";
    el.blur();
    expect(b.label).toBe("keep me");
    expect(map.boxes).toContain(b);
    expect(saves).toBe(0);
    // The DOM is still rebuilt from state so the emptied span heals.
    expect(renderItemCalls).toEqual(["b1"]);
  });

  it("reads the whole host element: pasted text outside the span is captured", () => {
    const { b, el } = addBox("b1", "old");
    startEdit(el, b);
    el.querySelector(".box-label")!.textContent = "foo";
    // Browsers sometimes land pasted content as siblings of the span.
    el.appendChild(document.createTextNode(" bar"));
    el.blur();
    expect(b.label).toBe("foo bar");
  });

  it("over-long commits truncate to MAX_LABEL_LEN and say so in the status", () => {
    const { b, el } = addBox("b1", "old");
    startEdit(el, b);
    el.querySelector(".box-label")!.textContent = "x".repeat(MAX_LABEL_LEN + 40);
    el.blur();
    expect(b.label).toHaveLength(MAX_LABEL_LEN);
    expect(saves).toBe(1);
    expect(statuses).toContain(
      "label truncated to " + MAX_LABEL_LEN + " characters",
    );
  });

  it("Escape without cancelDeletes reverts and keeps the box", () => {
    const { b, el } = addBox("b1", "old");
    startEdit(el, b);
    el.querySelector(".box-label")!.textContent = "typed";
    key(el, "Escape");
    expect(b.label).toBe("old");
    expect(map.boxes).toContain(b);
    expect(saves).toBe(0);
    expect(renderItemCalls).toEqual(["b1"]);
  });

  it("refuses to start while another edit is live", () => {
    const a = addBox("b1", "one");
    const c = addBox("b2", "two");
    startEdit(a.el, a.b);
    startEdit(c.el, c.b);
    expect(editingId()).toBe("b1");
    expect(c.el.hasAttribute("contenteditable")).toBe(false);
    key(a.el, "Escape");
  });

  describe("cancelDeletes (box spawned editing)", () => {
    it("Escape rolls back the spawn: box, edges, sub-maps, selection", () => {
      const { b, el } = addBox("b1", "seed");
      addBox("b10", "sibling prefix"); // must survive the path prune
      map.edges.push(
        { from: "b1", to: "b10" },
        { from: "b10", to: "b1" },
        { from: "b10", to: "b10" },
      );
      graph.maps = [
        { path: "/" },
        { path: "/b1" },
        { path: "/b1/kid" },
        { path: "/b10" },
      ];
      selected.add("b1");
      startEdit(el, b, { cancelDeletes: true });
      key(el, "Escape");

      expect(map.boxes.map((x) => x.id)).toEqual(["b10"]);
      expect(map.edges).toEqual([{ from: "b10", to: "b10" }]);
      expect(graph.maps.map((m) => m.path)).toEqual(["/", "/b10"]);
      expect(selected.has("b1")).toBe(false);
      expect(saves).toBe(1);
      expect(mutationKinds).toEqual(["doc"]);
      expect(renderItemCalls).toEqual(["b1"]);
      expect(statuses).toContain("cancelled");
    });

    it("rolls back sub-maps under a nested current path", () => {
      currentPath = "/parent";
      const { b, el } = addBox("b1", "seed");
      graph.maps = [
        { path: "/" },
        { path: "/parent" },
        { path: "/parent/b1" },
        { path: "/parent/b1/deep" },
        { path: "/parent/b1x" },
      ];
      startEdit(el, b, { cancelDeletes: true });
      key(el, "Escape");
      expect(graph.maps.map((m) => m.path)).toEqual([
        "/",
        "/parent",
        "/parent/b1x",
      ]);
    });

    it("a commit keeps the box: cancelDeletes only bites on Escape", () => {
      const { b, el } = addBox("b1", "seed");
      startEdit(el, b, { cancelDeletes: true });
      el.querySelector(".box-label")!.textContent = "named";
      key(el, "Enter");
      expect(map.boxes).toContain(b);
      expect(b.label).toBe("named");
      expect(saves).toBe(1);
    });

    it("an empty blur keeps the spawned box with its seed label", () => {
      // Pin of current behaviour: blur is a commit, so the rollback
      // does not run even though the user never named the box.
      const { b, el } = addBox("b1", "seed");
      startEdit(el, b, { cancelDeletes: true });
      el.querySelector(".box-label")!.textContent = "";
      el.blur();
      expect(map.boxes).toContain(b);
      expect(b.label).toBe("seed");
      expect(saves).toBe(0);
    });
  });

  describe("missing .box-label recovery", () => {
    it("rebuilds via renderAll and retries on the fresh element", () => {
      const b: BoxLike = { id: "b1", label: "old", x: 0, y: 0 };
      map.boxes.push(b);
      const broken = document.createElement("div");
      broken.className = "box";
      broken.dataset["id"] = "b1";
      canvas.appendChild(broken);
      renderAllImpl = () => {
        broken.remove();
        makeBoxEl(b);
      };
      startEdit(broken, b);
      expect(renderAllCalls).toBe(1);
      const fresh = canvas.querySelector<HTMLElement>('.box[data-id="b1"]')!;
      expect(isEditing()).toBe(true);
      expect(fresh.getAttribute("contenteditable")).toBe("true");
      fresh.querySelector(".box-label")!.textContent = "recovered";
      fresh.blur();
      expect(b.label).toBe("recovered");
    });

    it("gives up cleanly when the rebuild yields no element — no wedged flag", () => {
      // NOTE deliberately not covered: renderAll leaving ANOTHER
      // label-less .box[data-id] in the canvas makes startEdit recurse
      // without bound (no retry guard). Unreachable while renderItems
      // always emits the span; reported as a product bug, not pinned.
      const b: BoxLike = { id: "b1", label: "old", x: 0, y: 0 };
      const broken = document.createElement("div");
      broken.className = "box";
      broken.dataset["id"] = "b1";
      canvas.appendChild(broken);
      renderAllImpl = () => {
        broken.remove();
      };
      startEdit(broken, b);
      expect(renderAllCalls).toBe(1);
      expect(isEditing()).toBe(false);
      expect(broken.hasAttribute("contenteditable")).toBe(false);
    });
  });
});

// ── pure rollback helpers ───────────────────────────────────────────

describe("spawnedBoxMapPath", () => {
  it("joins without doubling the slash at the root", () => {
    expect(spawnedBoxMapPath("/", "b1")).toBe("/b1");
    expect(spawnedBoxMapPath("/a", "b1")).toBe("/a/b1");
    expect(spawnedBoxMapPath("/a/b", "c9")).toBe("/a/b/c9");
  });
});

describe("pruneMapsUnder", () => {
  it("drops the path and everything nested under it, nothing else", () => {
    const maps = [
      { path: "/" },
      { path: "/b1" },
      { path: "/b1/kid" },
      { path: "/b1/kid/deeper" },
      { path: "/b10" }, // shares the string prefix, is NOT nested
      { path: "/other" },
    ];
    expect(pruneMapsUnder(maps, "/b1").map((m) => m.path)).toEqual([
      "/",
      "/b10",
      "/other",
    ]);
  });

  it("returns everything when the path has no maps", () => {
    const maps = [{ path: "/" }, { path: "/a" }];
    expect(pruneMapsUnder(maps, "/zzz")).toEqual(maps);
  });
});
