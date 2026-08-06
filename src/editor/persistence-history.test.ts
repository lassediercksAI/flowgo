// Undo/redo history: what an edit costs, what the history retains, and
// whether stepping back and forward is exact for every kind of change
// the editor can make (brain#259).
//
// The cost assertions gate on whole-document PASS COUNTS, not on
// wall-clock — same reasoning as src/editor/perf/counters.ts. Each pass
// is O(map): on the 100,000-box fixture a native stringify is 9.1 ms, a
// parse 19.4 ms and the replacer-driven fingerprint 37.7 ms. "Is a large
// map editable" is decided by how many of those an edit triggers, and
// that number is identical on every machine.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_BYTE_BUDGET,
  graphPasses,
  historyBytes,
  historyDepth,
  isDirty,
  load,
  redo,
  refreshFromServer,
  resetGraphPasses,
  scheduleSave,
  undo,
  wirePersistence,
} from "./persistence.ts";

type Box = { id: string; label: string; x?: number; y?: number };
type MapLike = {
  path: string;
  boxes?: unknown[];
  edges?: unknown[];
  texts?: unknown[];
  lines?: unknown[];
  strokes?: unknown[];
  images?: unknown[];
};
type GraphLike = { maps: MapLike[] };

const doc = (): GraphLike => ({
  maps: [
    {
      path: "/",
      boxes: [
        { id: "b0", label: "one", x: 0, y: 0 },
        { id: "b1", label: "two", x: 200, y: 0 },
      ],
      edges: [{ from: "b0", to: "b1" }],
      texts: [],
      lines: [],
      strokes: [],
      images: [],
    },
    { path: "/b0", boxes: [{ id: "c0", label: "inside" }], edges: [] },
  ],
});

let graph: GraphLike;
let path: string;
/** Raw fetch bodies sent to /save, newest last. */
let posted: BodyInit[];
let stateBody: string;

/** The bytes of the n-th /save POST, whatever wrapper carried them. */
const postedText = async (n: number): Promise<string> => {
  const b = posted[n];
  return b instanceof Blob ? await b.text() : String(b);
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const root = (): MapLike => graph.maps[0]!;
const boxes = (): Box[] => root().boxes as Box[];

const wire = (): void => {
  wirePersistence({
    getGraph: () => graph,
    setGraph: (g) => { graph = g as GraphLike; },
    serializeGraph: () => "",
    setCurrentPath: (p) => { path = p; },
    getCurrentPath: () => path,
    readPathFromURL: () => "/",
    readViewFromURL: () => null,
    applyURLView: () => {},
    setStatus: () => {},
    clearSelected: () => {},
    clearSelectedEdge: () => {},
    isEditing: () => false,
    getSelectedIds: () => [],
    restoreSelection: () => {},
  });
};

afterEach(() => { vi.useRealTimers(); });

beforeEach(() => {
  graph = doc();
  path = "/";
  posted = [];
  stateBody = JSON.stringify(doc());
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/state")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "1" },
        json: () => Promise.resolve(JSON.parse(stateBody)),
      } as unknown as Response);
    }
    posted.push(init?.body as BodyInit);
    return Promise.resolve({
      ok: true,
      status: 204,
      headers: { get: () => "2" },
    } as unknown as Response);
  });
  vi.useFakeTimers();
  wire();
});

/** Load a baseline. No save is scheduled by a load, so nothing to wait for. */
const boot = async (): Promise<void> => {
  await load();
};

// Run the 200 ms debounce to completion, then let save()'s awaits
// resolve. Fake timers keep a 20-edit session instant instead of four
// real seconds; advanceTimersByTimeAsync flushes the microtask queue
// between timers, which is what carries save() through its fetch.
//
// Note what this deliberately does NOT do: call isDirty(). isDirty
// fingerprints the document, and these tests count whole-document
// passes — the instrument must not be one of the things measured.
const DEBOUNCE_MS = 200;
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
  await vi.advanceTimersByTimeAsync(0);
};

// ---------------------------------------------------------------
// Cost: how many O(map) passes does one edit take?
// ---------------------------------------------------------------

describe("cost of an edit", () => {
  it("spends exactly one whole-document pass per save, and it is the /save body", async () => {
    await boot();
    resetGraphPasses();
    boxes()[0]!.x = 40;
    scheduleSave();
    await settle();
    // One stringify — the POST body. The history entry is the PREVIOUS
    // body, pushed by reference. Nothing parses; nothing fingerprints.
    // If this number moves, editing a large map got slower by the size
    // of the map, which is the whole of brain#259.
    expect(graphPasses()).toEqual({ stringify: 1, parse: 0, fingerprint: 0 });
    expect(posted).toHaveLength(1);
  });

  it("costs the same per edit however many edits came before", async () => {
    await boot();
    for (let i = 0; i < 5; i++) {
      resetGraphPasses();
      boxes()[0]!.x = (i + 1) * 10;
      scheduleSave();
      await settle();
      expect(graphPasses().stringify).toBe(1);
      expect(graphPasses().parse).toBe(0);
      expect(graphPasses().fingerprint).toBe(0);
    }
  });

  it("does not fingerprint the document on the editing path at all", async () => {
    await boot();
    resetGraphPasses();
    for (let i = 0; i < 3; i++) {
      boxes()[0]!.label = "typing " + i;
      scheduleSave();
      await settle();
    }
    expect(graphPasses().fingerprint).toBe(0);
  });

  it("derives the dirty-check baseline once, then memoizes it", async () => {
    await boot();
    boxes()[0]!.x = 40;
    scheduleSave();
    await settle();
    stateBody = JSON.stringify(graph);

    resetGraphPasses();
    expect(await refreshFromServer()).toBe("unchanged");
    // Deriving the baseline from the last POSTed body costs one parse.
    // That parse used to run on every edit; now it runs here, on an
    // event the user did not cause, and only once.
    expect(graphPasses().parse).toBe(1);

    resetGraphPasses();
    expect(await refreshFromServer()).toBe("unchanged");
    expect(await refreshFromServer()).toBe("unchanged");
    expect(graphPasses().parse).toBe(0);
  });

  it("re-derives the baseline after the next save, and not before", async () => {
    await boot();
    stateBody = JSON.stringify(graph);
    await refreshFromServer(); // derives + memoizes
    resetGraphPasses();
    boxes()[0]!.x = 41;
    scheduleSave();
    await settle();
    expect(graphPasses().parse).toBe(0); // the save itself never parses
    stateBody = JSON.stringify(graph);
    await refreshFromServer();
    expect(graphPasses().parse).toBe(1); // re-derived once, lazily
  });

  it("hands the save body to fetch as a Blob, carrying the exact document", async () => {
    await boot();
    boxes()[0]!.label = "posted";
    scheduleSave();
    await settle();
    // Not a cosmetic detail: a multi-megabyte STRING body makes fetch
    // copy it on the main thread, which on a 100,000-box map was the
    // whole remaining hitch of an edit (83-133 ms). Same bytes, same
    // Content-Type — the wrapper is the point.
    expect(posted[0]).toBeInstanceOf(Blob);
    expect(await postedText(0)).toBe(JSON.stringify(graph));
  });

  it("spends one stringify and one parse on an undo", async () => {
    await boot();
    boxes()[0]!.x = 40;
    scheduleSave();
    await settle();
    resetGraphPasses();
    undo();
    expect(graphPasses()).toEqual({ stringify: 1, parse: 1, fingerprint: 0 });
  });
});

// ---------------------------------------------------------------
// Memory: the history must not grow without bound.
// ---------------------------------------------------------------

describe("history memory", () => {
  /** Edit `n` times, each a real change, running the debounce each time. */
  const editTimes = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      boxes()[0]!.x = i + 1;
      scheduleSave();
      await settle();
    }
  };

  it("keeps every step on a document that fits the budget", async () => {
    await boot();
    await editTimes(50);
    expect(historyDepth().undo).toBe(50);
    expect(historyBytes()).toBeLessThan(HISTORY_BYTE_BUDGET);
  });

  it("caps retained bytes on a document too large for full depth", async () => {
    // ~8 MB per snapshot, so the byte budget binds after ~8 steps —
    // long before the 100-entry limit would.
    graph = doc();
    const filler = "x".repeat(8000);
    root().boxes = Array.from({ length: 1000 }, (_, i) => ({
      id: "b" + i,
      label: filler,
      x: 0,
      y: 0,
    }));
    stateBody = JSON.stringify(graph);
    await boot();
    await editTimes(60);
    // The bound holds no matter how long the session runs — this is the
    // "a long editing session must not accumulate hundreds of full-graph
    // copies" half of brain#259.
    expect(historyBytes()).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
    // Depth was traded away, not the ability to undo.
    expect(historyDepth().undo).toBeGreaterThan(0);
    expect(historyDepth().undo).toBeLessThan(60);
  });

  it("never trims away the step the user just made", async () => {
    graph = doc();
    // A single snapshot larger than the whole budget.
    root().boxes = [{ id: "b0", label: "x".repeat(HISTORY_BYTE_BUDGET + 1000), x: 0 }];
    stateBody = JSON.stringify(graph);
    await boot();
    (boxes()[0] as Box).x = 5;
    scheduleSave();
    await settle();
    expect(historyDepth().undo).toBe(1);
    const before = clone(graph);
    undo();
    expect((graph.maps[0]!.boxes as Box[])[0]!.x).toBe(0);
    expect(before).not.toEqual(graph);
  });
});

// ---------------------------------------------------------------
// Correctness: every kind of change round-trips.
// ---------------------------------------------------------------

// Each case mutates `graph` the way the named editor operation does.
// The structural ones (paste, clone, align, media insert, submap
// add/remove) are the list brain#238/#24f left on the full-rebuild path
// — they are exactly the cases an inverse-patch history would have had
// to invent an inverse for, and the reason this one did not.
const cases: Array<[string, () => void]> = [
  ["box move", () => { boxes()[0]!.x = 999; boxes()[0]!.y = 42; }],
  ["box label edit", () => { boxes()[0]!.label = "renamed"; }],
  ["box add", () => { boxes().push({ id: "b9", label: "new", x: 10, y: 10 }); }],
  ["box delete", () => { root().boxes = boxes().slice(1); }],
  ["box style change", () => { (boxes()[0] as Record<string, unknown>)["shape"] = 1; }],
  ["edge add", () => { (root().edges as unknown[]).push({ from: "b1", to: "b0" }); }],
  ["edge delete", () => { root().edges = []; }],
  ["text add", () => { (root().texts as unknown[]).push({ id: "t0", text: "hi", x: 1, y: 2 }); }],
  ["line add", () => { (root().lines as unknown[]).push({ id: "l0", points: [0, 0, 5, 5] }); }],
  ["stroke add", () => { (root().strokes as unknown[]).push({ id: "s0", points: [1, 2, 3, 4] }); }],
  ["image insert", () => { (root().images as unknown[]).push({ id: "i0", src: "data:,x", x: 0, y: 0 }); }],
  ["bulk paste", () => {
    for (let i = 0; i < 50; i++) boxes().push({ id: "p" + i, label: "p", x: i, y: i });
  }],
  ["clone selection", () => {
    const src = boxes().slice();
    for (const b of src) boxes().push({ ...b, id: b.id + "_copy", x: (b.x ?? 0) + 20 });
  }],
  ["align", () => { for (const b of boxes()) b.y = 300; }],
  ["multi-select restyle", () => {
    for (const b of boxes()) (b as Record<string, unknown>)["palette"] = 3;
  }],
  ["submap add", () => { graph.maps.push({ path: "/b1", boxes: [{ id: "d0", label: "n" }], edges: [] }); }],
  ["submap remove (box delete cascade)", () => {
    root().boxes = boxes().filter((b) => b.id !== "b0");
    graph.maps = graph.maps.filter((m) => m.path !== "/b0");
  }],
  ["document default shape", () => {
    (graph as Record<string, unknown>)["defaultShape"] = 1;
  }],
];

describe("undo/redo round-trips every mutation type", () => {
  for (const [name, mutate] of cases) {
    it(name, async () => {
      await boot();
      const before = clone(graph);
      mutate();
      const after = clone(graph);
      expect(after).not.toEqual(before);
      scheduleSave();
      await settle();

      undo();
      expect(graph).toEqual(before);

      redo();
      expect(graph).toEqual(after);

      // And back again, to prove the stacks aren't one-shot.
      undo();
      expect(graph).toEqual(before);
    });
  }

  it("walks back through a mixed sequence one step at a time", async () => {
    await boot();
    const states: GraphLike[] = [clone(graph)];
    for (const [, mutate] of cases.slice(0, 8)) {
      mutate();
      scheduleSave();
      await settle();
      states.push(clone(graph));
    }
    for (let i = states.length - 2; i >= 0; i--) {
      undo();
      expect(graph).toEqual(states[i]);
    }
    for (let i = 1; i < states.length; i++) {
      redo();
      expect(graph).toEqual(states[i]);
    }
  });

  it("a new edit after an undo clears the redo branch", async () => {
    await boot();
    boxes()[0]!.x = 1;
    scheduleSave();
    await settle();
    undo();
    expect(historyDepth().redo).toBe(1);
    boxes()[0]!.label = "different branch";
    scheduleSave();
    await settle();
    expect(historyDepth().redo).toBe(0);
  });
});

// ---------------------------------------------------------------
// The brain#250 guarantee, restated against the new representation.
// ---------------------------------------------------------------

describe("undo after a remote apply", () => {
  /** The agent's document: a box the local page has never seen. */
  const remote = (): GraphLike => {
    const g = doc();
    (g.maps[0]!.boxes as Box[]).push({ id: "agent1", label: "written by the agent", x: 500, y: 500 });
    return g;
  };

  it("cannot resurrect the local document over the other writer's", async () => {
    await boot();
    // Local work, saved.
    boxes()[0]!.label = "my edit";
    scheduleSave();
    await settle();
    expect(historyDepth().undo).toBe(1);

    // The agent writes; we are clean, so it applies.
    stateBody = JSON.stringify(remote());
    expect(await refreshFromServer()).toBe("applied");
    expect(historyDepth()).toEqual({ undo: 0, redo: 0 });

    const postsBefore = posted.length;
    undo();
    // Nothing to step back to, and — the part that matters — nothing
    // was POSTed, so the agent's box is still in the document and still
    // on disk.
    expect(posted).toHaveLength(postsBefore);
    expect(boxes().some((b) => b.id === "agent1")).toBe(true);
    redo();
    expect(posted).toHaveLength(postsBefore);
    expect(boxes().some((b) => b.id === "agent1")).toBe(true);
  });

  it("drops a deep history, not just the top entry", async () => {
    await boot();
    for (let i = 0; i < 12; i++) {
      boxes()[0]!.x = i + 1;
      scheduleSave();
      await settle();
    }
    expect(historyDepth().undo).toBe(12);
    stateBody = JSON.stringify(remote());
    expect(await refreshFromServer()).toBe("applied");
    expect(historyDepth()).toEqual({ undo: 0, redo: 0 });
  });

  it("drops the redo branch too, so Ctrl+Y can't step forward past it", async () => {
    await boot();
    boxes()[0]!.x = 7;
    scheduleSave();
    await settle();
    undo();
    expect(historyDepth().redo).toBe(1);
    stateBody = JSON.stringify(remote());
    await vi.waitFor(() => expect(isDirty()).toBe(false), { timeout: 2000 });
    expect(await refreshFromServer()).toBe("applied");
    expect(historyDepth().redo).toBe(0);
    const postsBefore = posted.length;
    redo();
    expect(posted).toHaveLength(postsBefore);
    expect(boxes().some((b) => b.id === "agent1")).toBe(true);
  });

  it("still refuses to apply over an in-flight local change", async () => {
    await boot();
    boxes()[0]!.label = "mid-gesture";
    scheduleSave();
    stateBody = JSON.stringify(remote());
    expect(await refreshFromServer()).toBe("deferred");
    expect(boxes().some((b) => b.id === "agent1")).toBe(false);
  });

  it("refuses to apply over a drag that has not fired a mutation yet", async () => {
    await boot();
    // A box drag writes b.x/b.y live and only calls a mutator on
    // release, so nothing has scheduled a save. A dirty check based on
    // "did anything call scheduleSave" would read clean here and the
    // apply would eat the drag.
    boxes()[0]!.x = 12345;
    expect(isDirty()).toBe(true);
    stateBody = JSON.stringify(remote());
    expect(await refreshFromServer()).toBe("deferred");
    expect(boxes()[0]!.x).toBe(12345);
  });
});
