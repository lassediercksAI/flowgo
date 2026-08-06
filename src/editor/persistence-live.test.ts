// The receiving end of the live-events stream (brain#250): what
// refreshFromServer applies, what it refuses to apply, and what it
// must not disturb when it does.
//
// The bar these tests set is the second user story on the card — an
// incoming agent edit must never silently destroy work in progress —
// plus the "magical vs infuriating" one: the camera and the submap the
// user is looking at do not move.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getKnownRevision,
  isDirty,
  refreshFromServer,
  scheduleSave,
  load,
  undo,
  wirePersistence,
} from "./persistence.ts";

type MapLike = { path: string; boxes?: unknown[]; edges?: unknown[] };
type GraphLike = { maps: MapLike[] };

const doc = (...labels: string[]): GraphLike => ({
  maps: [
    { path: "/", boxes: labels.map((l, i) => ({ id: "b" + i, label: l })), edges: [] },
    { path: "/b0", boxes: [{ id: "c0", label: "inside" }], edges: [] },
  ],
});

interface Harness {
  graph: GraphLike;
  path: string;
  navigations: Array<{ path: string; keepViewport: boolean }>;
  selected: string[];
  restored: string[][];
  editing: boolean;
  cleared: number;
}

let h: Harness;
let stateBody: string;
let stateRevision: string | null;
let stateStatus: number;
let stateCalls: number;

const respond = (): Response =>
  ({
    ok: stateStatus >= 200 && stateStatus < 300,
    status: stateStatus,
    headers: { get: (k: string) => (k === "X-Flowgo-Revision" ? stateRevision : null) },
    json: () => Promise.resolve(JSON.parse(stateBody)),
  }) as unknown as Response;

const wire = (): void => {
  wirePersistence({
    getGraph: () => h.graph,
    setGraph: (g) => { h.graph = g as GraphLike; },
    serializeGraph: () => "",
    setCurrentPath: (p, opts) => {
      h.path = p;
      h.navigations.push({ path: p, keepViewport: opts?.keepViewport === true });
    },
    getCurrentPath: () => h.path,
    readPathFromURL: () => "/",
    readViewFromURL: () => null,
    applyURLView: () => {},
    setStatus: () => {},
    clearSelected: () => { h.selected = []; h.cleared++; },
    clearSelectedEdge: () => {},
    isEditing: () => h.editing,
    getSelectedIds: () => [...h.selected],
    restoreSelection: (ids) => { h.restored.push([...ids]); h.selected = [...ids]; },
  });
};

/** Load the given document so savedSnapshot has a baseline. */
const boot = async (g: GraphLike, path = "/"): Promise<void> => {
  stateBody = JSON.stringify(g);
  stateRevision = "1";
  await load();
  h.path = path;
  h.navigations = [];
  h.cleared = 0;
  h.restored = [];
};

beforeEach(() => {
  h = {
    graph: { maps: [] },
    path: "/",
    navigations: [],
    selected: [],
    restored: [],
    editing: false,
    cleared: 0,
  };
  stateBody = JSON.stringify(doc("one"));
  stateRevision = "1";
  stateStatus = 200;
  stateCalls = 0;
  vi.stubGlobal("fetch", (url: string) => {
    if (String(url).startsWith("/state")) {
      stateCalls++;
      return Promise.resolve(respond());
    }
    // /save
    return Promise.resolve({
      ok: true,
      status: 204,
      headers: { get: () => stateRevision },
    } as unknown as Response);
  });
  wire();
});

describe("isDirty", () => {
  it("is clean right after a load", async () => {
    await boot(doc("one"));
    expect(isDirty()).toBe(false);
  });

  it("is dirty once the graph diverges from what was saved", async () => {
    await boot(doc("one"));
    (h.graph.maps[0]!.boxes as Array<{ label: string }>)[0]!.label = "typed";
    expect(isDirty()).toBe(true);
  });

  it("is dirty while a debounced save is pending, clean once it lands", async () => {
    await boot(doc("one"));
    scheduleSave();
    expect(isDirty()).toBe(true);
    await vi.waitFor(() => expect(isDirty()).toBe(false));
  });

  it("is dirty while an inline label edit is open", async () => {
    await boot(doc("one"));
    // The characters aren't in the graph yet, so a JSON compare would
    // call this clean and the apply would rip the contenteditable out
    // from under the cursor.
    h.editing = true;
    expect(isDirty()).toBe(true);
  });

  it("is dirty before the first load — there is no baseline", () => {
    expect(isDirty()).toBe(true);
  });
});

describe("refreshFromServer on a clean document", () => {
  it("applies the server's document", async () => {
    await boot(doc("one"));
    stateBody = JSON.stringify(doc("one", "added by the agent"));
    stateRevision = "2";

    await expect(refreshFromServer()).resolves.toBe("applied");
    expect(h.graph.maps[0]!.boxes).toHaveLength(2);
    expect(getKnownRevision()).toBe(2);
  });

  it("keeps the camera and the submap the user is looking at", async () => {
    await boot(doc("one"), "/b0");
    stateBody = JSON.stringify(doc("one", "two"));

    await expect(refreshFromServer()).resolves.toBe("applied");
    // Same path, and keepViewport — no recentre, no navigating the
    // user away mid-session.
    expect(h.navigations).toEqual([{ path: "/b0", keepViewport: true }]);
  });

  it("falls back to the root map when the current submap is gone", async () => {
    await boot(doc("one"), "/b0");
    // The agent deleted the node whose submap we were inside.
    stateBody = JSON.stringify({ maps: [{ path: "/", boxes: [], edges: [] }] });

    await expect(refreshFromServer()).resolves.toBe("applied");
    // Recentre is correct HERE and only here: we had to move.
    expect(h.navigations).toEqual([{ path: "/", keepViewport: false }]);
  });

  it("restores selection of items the incoming document still has", async () => {
    await boot(doc("one", "two"));
    h.selected = ["b0", "b1"];
    stateBody = JSON.stringify(doc("one", "two", "three"));

    await expect(refreshFromServer()).resolves.toBe("applied");
    expect(h.cleared).toBe(1);
    expect(h.restored).toEqual([["b0", "b1"]]);
  });

  it("does not restore selection across a forced map change", async () => {
    await boot(doc("one"), "/b0");
    h.selected = ["c0"];
    stateBody = JSON.stringify({ maps: [{ path: "/", boxes: [], edges: [] }] });

    await refreshFromServer();
    expect(h.restored).toEqual([]);
  });

  it("reports unchanged, and rebuilds nothing, when we are already current", async () => {
    await boot(doc("one"));
    // e.g. our own save raced the agent's write and the file already
    // says what we say.
    await expect(refreshFromServer()).resolves.toBe("unchanged");
    expect(h.navigations).toEqual([]);
  });

  it("drops the undo stack so the next Ctrl+Z can't revert the other writer", async () => {
    await boot(doc("one"));
    // Build one real undo entry the way the editor does.
    (h.graph.maps[0]!.boxes as Array<{ label: string }>)[0]!.label = "mine";
    scheduleSave();
    await vi.waitFor(() => expect(isDirty()).toBe(false));

    stateBody = JSON.stringify(doc("mine", "agent's box"));
    await expect(refreshFromServer()).resolves.toBe("applied");

    // Undo now has nothing to replay. If it did, it would restore a
    // document without the agent's box AND POST it back — silently
    // reverting work the user never chose to undo.
    const before = JSON.stringify(h.graph);
    undo();
    expect(JSON.stringify(h.graph)).toBe(before);
  });
});

describe("refreshFromServer on a dirty document", () => {
  it("refuses to apply and leaves the local document alone", async () => {
    await boot(doc("one"));
    (h.graph.maps[0]!.boxes as Array<{ label: string }>)[0]!.label = "half-typed";
    const before = JSON.stringify(h.graph);
    stateBody = JSON.stringify(doc("one", "agent's box"));

    await expect(refreshFromServer()).resolves.toBe("deferred");
    expect(JSON.stringify(h.graph)).toBe(before);
    expect(h.navigations).toEqual([]);
  });

  it("does not even fetch when it already knows it can't apply", async () => {
    await boot(doc("one"));
    h.editing = true;
    const callsBefore = stateCalls;
    await expect(refreshFromServer()).resolves.toBe("deferred");
    expect(stateCalls).toBe(callsBefore);
  });

  it("defers when the user starts editing DURING the fetch", async () => {
    // The fetch is a suspension point measured in milliseconds, but a
    // keystroke fits in it easily. Applying then would drop it.
    await boot(doc("one"));
    stateBody = JSON.stringify(doc("one", "agent's box"));
    vi.stubGlobal("fetch", () => {
      h.editing = true; // the user starts typing mid-flight
      return Promise.resolve(respond());
    });

    await expect(refreshFromServer()).resolves.toBe("deferred");
    expect(h.graph.maps[0]!.boxes).toHaveLength(1);
  });

  it("applies once the pending save has landed", async () => {
    await boot(doc("one"));
    (h.graph.maps[0]!.boxes as Array<{ label: string }>)[0]!.label = "mine";
    scheduleSave();
    expect(await refreshFromServer()).toBe("deferred");

    await vi.waitFor(() => expect(isDirty()).toBe(false));
    stateBody = JSON.stringify(doc("mine", "agent's box"));
    expect(await refreshFromServer()).toBe("applied");
  });
});

describe("refreshFromServer when the server is unreachable", () => {
  it("reports failure without touching the document", async () => {
    await boot(doc("one"));
    const before = JSON.stringify(h.graph);
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network down")));

    await expect(refreshFromServer()).resolves.toBe("failed");
    expect(JSON.stringify(h.graph)).toBe(before);
  });

  it("reports failure on a non-OK response", async () => {
    await boot(doc("one"));
    stateStatus = 500;
    await expect(refreshFromServer()).resolves.toBe("failed");
  });

  it("never applies an empty document over a real one", async () => {
    // A half-written file (someone :w-ing in vim) can make /state
    // answer with something unusable. Refusing costs a retry;
    // accepting costs the map on screen.
    await boot(doc("one"));
    stateBody = JSON.stringify({ maps: [] });
    await expect(refreshFromServer()).resolves.toBe("failed");
    expect(h.graph.maps).toHaveLength(2);
  });
});
