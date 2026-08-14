// The delta1 save emitter (brain#25c), client half. The contract
// under test, in server terms (pkg/flowgo/delta.go is the source of
// truth):
//
//   - a server that never advertised `X-Flowgo-Save: delta1` sees
//     byte-identical full saves — the capability gate IS the
//     shared-bundle protection;
//   - the first save after load is full even against a capable
//     server; only a save the server acknowledged (with a revision)
//     arms the delta path;
//   - an armed page sends the Delta JSON with the delta1 save-mode
//     header and the base revision, not the full document;
//   - any delta failure (409 first among them) drops back to full
//     saves, and a full save's success re-arms;
//   - deletes are remembered as deletes across a debounce window, and
//     a mutation landing while a save is in flight survives to the
//     next save;
//   - a delta bigger than the document falls back to the full body.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeReq {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface GraphBox {
  id: string;
  [k: string]: unknown;
}
interface TestGraph {
  maps: Array<{
    path: string;
    boxes: GraphBox[];
    edges: unknown[];
    [k: string]: unknown;
  }>;
  defaultShape?: number;
}

let graph: TestGraph;
let stateHeaders: Record<string, string>;
let saveResponses: Array<{ ok: boolean; status: number }>;
let saves: FakeReq[] = [];
let revision: number;
// When set, revisions are served from this list instead of the
// numeric counter — the hosted server's opaque content-hash regime.
let revTokens: string[] | null = null;
let revIdx = 0;
const currentRev = (): string =>
  revTokens ? revTokens[Math.min(revIdx, revTokens.length - 1)]! : String(revision);
const statuses: string[] = [];

const bodyText = async (r: FakeReq): Promise<string> =>
  typeof r.body === "string" ? r.body : await (r.body as Blob).text();

const headerBag = (h: Record<string, string>) => ({
  get: (k: string) => h[k] ?? null,
});

const setup = async (opts?: { graph?: TestGraph }) => {
  vi.resetModules();
  statuses.length = 0;
  saves = [];
  revision = 7;
  saveResponses = [];
  // Padding boxes keep the document comfortably larger than any delta
  // these tests emit — the size safety valve has its own test below.
  graph = opts?.graph ?? {
    maps: [
      {
        path: "/",
        boxes: [
          { id: "b1", x: 1, y: 2, label: "one" },
          { id: "p1", x: 10, y: 10, label: "padding padding padding" },
          { id: "p2", x: 20, y: 20, label: "padding padding padding" },
          { id: "p3", x: 30, y: 30, label: "padding padding padding" },
          { id: "p4", x: 40, y: 40, label: "padding padding padding" },
        ],
        edges: [],
      },
    ],
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/state")) {
      return {
        ok: true,
        status: 200,
        headers: headerBag({
          ...stateHeaders,
          "X-Flowgo-Revision": currentRev(),
        }),
        json: async () => graph,
        text: async () => "",
      };
    }
    saves.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    const r = saveResponses.length > 1 ? saveResponses.shift()! : saveResponses[0]!;
    if (r.ok) {
      revision++;
      revIdx++;
    }
    return {
      ok: r.ok,
      status: r.status,
      headers: headerBag(r.ok ? { "X-Flowgo-Revision": currentRev() } : {}),
      json: async () => ({}),
      text: async () => "",
    };
  });
  const p = await import("./persistence.ts");
  const m = await import("./mutations.ts");
  p.wirePersistence({
    getGraph: () => graph,
    setGraph: (g: TestGraph) => {
      graph = g;
    },
    setStatus: (s: string) => statuses.push(s),
    setCurrentPath: () => {},
    getCurrentPath: () => "/",
    readPathFromURL: () => "/",
    readViewFromURL: () => null,
    applyURLView: () => {},
    clearSelected: () => {},
    clearSelectedEdge: () => {},
  } as never);
  m.wireMutations({
    scheduleSave: () => p.scheduleSave(),
    getMapPath: () => "/",
  });
  return { p, m };
};

/** load, mutate once, and land the first (always-full) save. */
const armed = async (opts?: { graph?: TestGraph }) => {
  const mods = await setup(opts);
  saveResponses = [{ ok: true, status: 204 }];
  await mods.p.load();
  graph.maps[0]!.boxes[0]!.label = "renamed";
  mods.m.mutatedBox();
  await vi.runOnlyPendingTimersAsync();
  expect(saves).toHaveLength(1);
  expect(saves[0]!.headers["X-Flowgo-Save"]).toBeUndefined();
  return mods;
};

describe("delta1 save emission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stateHeaders = { "X-Flowgo-Save": "delta1" };
    revTokens = null;
    revIdx = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("capability absent → full save, byte-identical body to today", async () => {
    stateHeaders = {};
    const { p, m } = await setup();
    saveResponses = [{ ok: true, status: 204 }];
    await p.load();
    // Two saves: even the second (post-acknowledgement) stays full.
    for (const label of ["first", "second"]) {
      graph.maps[0]!.boxes[0]!.label = label;
      m.mutatedBox();
      await vi.runOnlyPendingTimersAsync();
    }
    expect(saves).toHaveLength(2);
    for (const s of saves) {
      expect(s.headers["X-Flowgo-Save"]).toBeUndefined();
      expect(s.headers["X-Flowgo-Base-Revision"]).toBeUndefined();
    }
    expect(await bodyText(saves[1]!)).toBe(JSON.stringify(graph));
  });

  it("first save after load is full even with the capability", async () => {
    const { p, m } = await setup();
    saveResponses = [{ ok: true, status: 204 }];
    await p.load();
    graph.maps[0]!.boxes[0]!.label = "changed";
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.headers["X-Flowgo-Save"]).toBeUndefined();
    expect(await bodyText(saves[0]!)).toBe(JSON.stringify(graph));
  });

  it("an armed page emits the delta, not the document", async () => {
    const { m } = await armed();
    // The full save acknowledged with revision 8 → that is the base.
    graph.maps[0]!.boxes[0]!.label = "moved";
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync();
    expect(saves).toHaveLength(2);
    const s = saves[1]!;
    expect(s.url).toContain("/save");
    expect(s.headers["X-Flowgo-Save"]).toBe("delta1");
    expect(s.headers["X-Flowgo-Base-Revision"]).toBe("8");
    const body = await bodyText(s);
    expect(body).not.toBe(JSON.stringify(graph));
    expect(JSON.parse(body)).toEqual({
      base: 8,
      ops: [
        {
          op: "upsert",
          kind: "box",
          map: "/",
          item: { id: "b1", x: 1, y: 2, label: "moved" },
        },
      ],
    });
    expect(statuses[statuses.length - 1]).toBe("saved");
  });

  it("409 → next save is full; its success re-arms delta mode", async () => {
    const { m } = await armed();
    saveResponses = [
      { ok: false, status: 409 },
      { ok: true, status: 204 },
    ];
    graph.maps[0]!.boxes[0]!.label = "conflicted";
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync(); // → delta, rejected 409
    expect(saves[1]!.headers["X-Flowgo-Save"]).toBe("delta1");
    expect(statuses[statuses.length - 1]).toContain("NOT saved");
    await vi.advanceTimersByTimeAsync(5000); // retry window
    expect(saves).toHaveLength(3);
    // The retry is a FULL save — no mode header, whole document.
    expect(saves[2]!.headers["X-Flowgo-Save"]).toBeUndefined();
    expect(await bodyText(saves[2]!)).toBe(JSON.stringify(graph));
    expect(statuses[statuses.length - 1]).toBe("saved");
    // …and its acknowledgement re-arms: the next change is a delta.
    graph.maps[0]!.boxes[0]!.label = "recovered";
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync();
    expect(saves).toHaveLength(4);
    expect(saves[3]!.headers["X-Flowgo-Save"]).toBe("delta1");
  });

  it("upsert-then-delete in one window emits the delete only", async () => {
    const { m } = await armed();
    const map = graph.maps[0]!;
    // b1 exists in the base: edit it, then delete it (the editor's
    // delete flow prunes submaps too, hence mutatedDoc).
    map.boxes[0]!.label = "doomed";
    m.mutatedBox();
    // b9 never reached the server: created and deleted in-window.
    map.boxes.push({ id: "b9", x: 5, y: 5 });
    m.mutatedBox();
    map.boxes = map.boxes.filter((b) => b.id !== "b1" && b.id !== "b9");
    m.mutatedDoc();
    await vi.runOnlyPendingTimersAsync();
    expect(saves).toHaveLength(2);
    const delta = JSON.parse(await bodyText(saves[1]!));
    expect(delta.ops).toEqual([
      { op: "delete", kind: "box", map: "/", id: "b1" },
    ]);
  });

  it("a mutation during an in-flight save survives to the next one", async () => {
    const { p, m } = await armed();
    // Hold the delta save open.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/save")) await gate;
      return realFetch(url as never, init as never);
    });
    saveResponses = [{ ok: true, status: 204 }];
    graph.maps[0]!.boxes[0]!.label = "first";
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync(); // delta posted, hanging
    // While it hangs: a second change lands.
    graph.maps[0]!.boxes.push({ id: "b2", x: 9, y: 9 });
    m.mutatedBox();
    release();
    await vi.runOnlyPendingTimersAsync(); // ack + the debounced save
    const last = saves[saves.length - 1]!;
    expect(last.headers["X-Flowgo-Save"]).toBe("delta1");
    const delta = JSON.parse(await bodyText(last));
    // The in-flight-window change is here, based on the NEW revision.
    expect(delta.ops).toContainEqual({
      op: "upsert",
      kind: "box",
      map: "/",
      item: { id: "b2", x: 9, y: 9 },
    });
    expect(p).toBeTruthy();
  });

  it("opaque revision tokens ride the header only; 409 still recovers", async () => {
    // The hosted server mints content-hash tokens and reads the base
    // ONLY from the X-Flowgo-Base-Revision request header; the body's
    // numeric `base` is CLI compatibility and must be absent here.
    revTokens = ["ffeeddccbbaa0099", "a1b2c3d4e5f60718", "0badc0ffee15dead"];
    const { m } = await armed();
    graph.maps[0]!.boxes[0]!.label = "hashed";
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync();
    expect(saves).toHaveLength(2);
    const s = saves[1]!;
    expect(s.headers["X-Flowgo-Save"]).toBe("delta1");
    // The token the full save was acknowledged with, byte for byte.
    expect(s.headers["X-Flowgo-Base-Revision"]).toBe("a1b2c3d4e5f60718");
    const delta = JSON.parse(await bodyText(s));
    expect(delta).not.toHaveProperty("base");
    expect(delta.ops).toEqual([
      {
        op: "upsert",
        kind: "box",
        map: "/",
        item: { id: "b1", x: 1, y: 2, label: "hashed" },
      },
    ]);
    // A bodyless 409 (the hosted server's stale-token answer) falls
    // back to a full save exactly like the CLI's.
    saveResponses = [
      { ok: false, status: 409 },
      { ok: true, status: 204 },
    ];
    graph.maps[0]!.boxes[0]!.label = "stale";
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5000);
    const retry = saves[saves.length - 1]!;
    expect(retry.headers["X-Flowgo-Save"]).toBeUndefined();
    expect(await bodyText(retry)).toBe(JSON.stringify(graph));
    expect(statuses[statuses.length - 1]).toBe("saved");
  });

  it("a delta larger than the document falls back to the full body", async () => {
    const tiny: TestGraph = {
      maps: [{ path: "/", boxes: [{ id: "b" }], edges: [] }],
    };
    const { m } = await armed({ graph: tiny });
    saveResponses = [{ ok: true, status: 204 }];
    graph.maps[0]!.boxes[0]!.x = 1;
    m.mutatedBox();
    await vi.runOnlyPendingTimersAsync();
    // The op envelope alone outweighs this document, so the save is
    // full despite the armed delta path.
    expect(saves).toHaveLength(2);
    expect(saves[1]!.headers["X-Flowgo-Save"]).toBeUndefined();
    expect(await bodyText(saves[1]!)).toBe(JSON.stringify(graph));
  });
});
