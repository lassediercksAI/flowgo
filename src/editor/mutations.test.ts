// The mutation chokepoint is pure fan-out: every mutator must
// invalidate the right cull index, always invalidate proximity + uid,
// then save, then (optionally) emit a typed event. The three
// invalidation modules are mocked — this file pins the chokepoint's
// dispatch contract, not the index internals (those have their own
// tests). A shared trace records every downstream call in order so
// tests can assert sequencing, not just "was called".
//
// mutations.ts keeps its wiring in a module-level `bindings` slot with
// no way back to the unwired state, so each test imports a fresh
// module instance via vi.resetModules() — the unwired-throw case would
// otherwise only be testable as the first test of the file.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutationEvent, MutationKind } from "./mutations.ts";

const h = vi.hoisted(() => ({ trace: [] as string[] }));

vi.mock("./cull-index.ts", () => ({
  invalidateCullIndex: vi.fn((kind?: string) => {
    // `undefined` means "drop every index" downstream.
    h.trace.push(`cull:${kind ?? "*"}`);
  }),
}));
vi.mock("./proximity-index.ts", () => ({
  invalidateProximityIndex: vi.fn(() => h.trace.push("prox")),
}));
vi.mock("./uid.ts", () => ({
  invalidateUidCache: vi.fn(() => h.trace.push("uid")),
}));

type Mutations = typeof import("./mutations.ts");
let m: Mutations;

beforeEach(async () => {
  vi.resetModules();
  m = await import("./mutations.ts");
  h.trace.length = 0;
  vi.clearAllMocks();
});

const wire = (extra: Partial<Parameters<Mutations["wireMutations"]>[0]> = {}): void => {
  m.wireMutations({ scheduleSave: () => h.trace.push("save"), ...extra });
};

describe("unwired module", () => {
  it("throws before touching anything — a save path must exist", () => {
    expect(() => m.mutatedBox()).toThrow("wireMutations() not called");
    // The guard sits before the invalidations: a half-fired mutation
    // (caches dropped, nothing saved) would be worse than the throw.
    expect(h.trace).toEqual([]);
  });
});

describe("per-kind dispatch", () => {
  // Every mutator, its event kind, and the cull index it may have
  // moved. "box" passes "box" here; cull-index itself expands that to
  // box+edge (edge segments derive from box positions). currentMap and
  // doc span kinds, so they drop everything (undefined = all).
  const table: ReadonlyArray<[keyof Mutations, MutationKind, string]> = [
    ["mutatedBox", "box", "cull:box"],
    ["mutatedEdge", "edge", "cull:edge"],
    ["mutatedText", "text", "cull:text"],
    ["mutatedLine", "line", "cull:line"],
    ["mutatedStroke", "stroke", "cull:stroke"],
    ["mutatedImage", "image", "cull:image"],
    ["mutatedCurrentMap", "currentMap", "cull:*"],
    ["mutatedDoc", "doc", "cull:*"],
  ];

  for (const [fn, kind, cull] of table) {
    it(`${fn} → invalidate ${cull}, save, emit "${kind}"`, () => {
      const events: MutationEvent[] = [];
      wire({
        onMutate: (e) => {
          events.push(e);
          h.trace.push("mutate"); // traced so emit-vs-save ORDER is observed
        },
      });
      (m[fn] as () => void)();
      // Full sequence, in order: kind-scoped cull invalidation, then
      // proximity and uid (unconditional), then persistence, then the
      // typed event — the event must describe an already-scheduled
      // save, never precede it.
      expect(h.trace).toEqual([cull, "prox", "uid", "save", "mutate"]);
      expect(events).toEqual([{ kind, mapPath: "/" }]);
    });
  }

  it("schedules exactly one save per mutation call", () => {
    wire();
    m.mutatedBox();
    m.mutatedBox();
    m.mutatedDoc();
    expect(h.trace.filter((t) => t === "save")).toHaveLength(3);
  });
});

describe("optional bindings", () => {
  it("works with scheduleSave alone — onMutate and getMapPath are optional", () => {
    wire();
    expect(() => m.mutatedText()).not.toThrow();
    expect(h.trace).toEqual(["cull:text", "prox", "uid", "save"]);
  });

  it("defaults mapPath to the root when getMapPath is absent", () => {
    let seen: MutationEvent | null = null;
    wire({ onMutate: (e) => (seen = e) });
    m.mutatedEdge();
    expect(seen).toEqual({ kind: "edge", mapPath: "/" });
  });

  it("resolves the map path per event, at emit time", () => {
    // A collab binding scopes each diff to the map focused WHEN the
    // mutation fired — the path must be re-read every time, not
    // captured at wiring.
    let path = "/b1";
    const events: MutationEvent[] = [];
    wire({ getMapPath: () => path, onMutate: (e) => events.push(e) });
    m.mutatedBox();
    path = "/b1/c2";
    m.mutatedBox();
    expect(events.map((e) => e.mapPath)).toEqual(["/b1", "/b1/c2"]);
  });

  it("does not consult getMapPath when no one is listening", () => {
    // getMapPath may walk editor state; without an onMutate consumer
    // there is no event to scope, so it must not run.
    const getMapPath = vi.fn(() => "/");
    wire({ getMapPath });
    m.mutatedBox();
    expect(getMapPath).not.toHaveBeenCalled();
  });
});

describe("re-wiring", () => {
  it("replaces the previous bindings wholesale", () => {
    const first = vi.fn();
    m.wireMutations({ scheduleSave: first });
    m.mutatedBox();
    expect(first).toHaveBeenCalledTimes(1);
    wire();
    m.mutatedBox();
    // The stale save path must not fire alongside the new one.
    expect(first).toHaveBeenCalledTimes(1);
    expect(h.trace.filter((t) => t === "save")).toHaveLength(1);
  });
});
