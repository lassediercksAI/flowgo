// Collab extension point: bootstrap-order plumbing + the type contract
// a downstream (flowgo-website) plugin compiles against.
//
// The module is deliberately tiny — a handle slot and a waiting list —
// but the ordering rules are load-bearing: a plugin may import and
// register BEFORE the editor's main.ts has run, or lazily long AFTER.
// Both must end up wired exactly once per registration.
//
// Module-level state (handle + awaiting queue) persists for the life of
// the module and there is no reset export, so every test re-imports a
// fresh copy via vi.resetModules() + dynamic import instead of sharing
// one module across tests.
//
// The graph interfaces mirror pkg/graph.Graph and are ALSO consumed by
// the website side — the type-contract test below pins their shape at
// compile time and their JSON-safety at runtime; it must never require
// changing the exported types to pass.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CollabHandle,
  FlowgoGraph,
} from "./collab-api.ts";
import type { MutationEvent } from "./mutations.ts";

type CollabModule = typeof import("./collab-api.ts");

let mod: CollabModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./collab-api.ts");
});

const makeHandle = (tag = "h"): CollabHandle & { tag: string } => ({
  tag,
  snapshot: () => ({ maps: [] }),
  applyRemotePatch: (fn) => fn({ maps: [] }),
  onLocalMutation: () => () => {},
});

describe("whenCollabReady / exposeCollabHandle ordering", () => {
  it("does not invoke a callback before the editor exposes a handle", () => {
    const cb = vi.fn();
    mod.whenCollabReady(cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires a queued callback when the handle arrives (plugin loaded first)", () => {
    const cb = vi.fn();
    mod.whenCollabReady(cb);
    const h = makeHandle();
    mod.exposeCollabHandle(h);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(h);
  });

  it("fires immediately and synchronously when the handle already exists (plugin loaded late)", () => {
    const h = makeHandle();
    mod.exposeCollabHandle(h);
    const cb = vi.fn();
    mod.whenCollabReady(cb);
    // Synchronous: a lazily-loaded plugin must be able to snapshot()
    // right after whenCollabReady returns, without awaiting anything.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(h);
  });

  it("flushes multiple queued plugins in registration order", () => {
    const order: string[] = [];
    mod.whenCollabReady(() => order.push("a"));
    mod.whenCollabReady(() => order.push("b"));
    mod.whenCollabReady(() => order.push("c"));
    mod.exposeCollabHandle(makeHandle());
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("fires each queued callback exactly once across a repeated expose", () => {
    // exposeCollabHandle drains the queue (splice, not slice) — a
    // second expose must not replay plugins that were already wired,
    // or every plugin double-subscribes.
    const cb = vi.fn();
    mod.whenCollabReady(cb);
    mod.exposeCollabHandle(makeHandle("first"));
    mod.exposeCollabHandle(makeHandle("second"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("last exposed handle wins for later registrations", () => {
    const h1 = makeHandle("first");
    const h2 = makeHandle("second");
    mod.exposeCollabHandle(h1);
    mod.exposeCollabHandle(h2);
    const cb = vi.fn();
    mod.whenCollabReady(cb);
    expect(cb).toHaveBeenCalledWith(h2);
  });

  it("supports the full lifecycle: register → wire → subscribe → unsubscribe", () => {
    // A minimal but functional handle, shaped exactly like main.ts
    // would build it. This doubles as a compile-time pin of the
    // CollabHandle surface: snapshot(), applyRemotePatch(fn),
    // onLocalMutation(cb) → unsubscribe.
    const graph: FlowgoGraph = { maps: [{ path: "/", boxes: [], edges: [] }] };
    const subs = new Set<(e: MutationEvent) => void>();
    const handle: CollabHandle = {
      snapshot: () => JSON.parse(JSON.stringify(graph)) as FlowgoGraph,
      applyRemotePatch: (fn) => fn(graph),
      onLocalMutation: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
    };

    const seen: MutationEvent[] = [];
    let unsub: (() => void) | null = null;
    mod.whenCollabReady((h) => {
      unsub = h.onLocalMutation((e) => seen.push(e));
    });
    mod.exposeCollabHandle(handle);

    const fire = (e: MutationEvent) => subs.forEach((cb) => cb(e));
    fire({ kind: "box", mapPath: "/" });
    expect(seen).toEqual([{ kind: "box", mapPath: "/" }]);

    // snapshot() is a clone: mutating it must not touch the live graph.
    const snap = handle.snapshot();
    snap.maps[0]!.boxes.push({ id: "b1", label: "x", x: 0, y: 0 });
    expect(graph.maps[0]!.boxes).toHaveLength(0);

    // applyRemotePatch writes through to the live graph.
    handle.applyRemotePatch((g) => {
      g.maps[0]!.boxes.push({ id: "b2", label: "remote", x: 1, y: 2 });
    });
    expect(graph.maps[0]!.boxes.map((b) => b.id)).toEqual(["b2"]);

    unsub!();
    fire({ kind: "edge", mapPath: "/" });
    expect(seen).toHaveLength(1);
  });
});

describe("graph type contract (mirror of pkg/graph.Graph)", () => {
  it("a fully-populated graph is plain JSON — survives a round-trip verbatim", () => {
    // The website plugin forwards snapshots to a sidecar as JSON "without
    // translation". If any field here stops compiling, the on-disk
    // mirror has drifted — fix the producer, do NOT edit the types.
    const graph: FlowgoGraph = {
      version: "1",
      defaultShape: 2,
      maps: [
        {
          path: "/b1",
          boxes: [
            {
              id: "b1",
              label: "box",
              x: 10,
              y: 20,
              palette: 3,
              font: 1,
              anchor: true,
              w: 120,
              h: 80,
              shape: 1,
            },
            // Optionals genuinely optional: the minimal box compiles too.
            { id: "b2", label: "", x: 0, y: 0 },
          ],
          edges: [
            {
              from: "b1",
              fromHandle: "e",
              to: "b2",
              toHandle: "w",
              palette: 2,
              label: "relates to",
            },
            { from: "b2", to: "b1" },
          ],
          texts: [{ id: "t1", label: "note", x: 1, y: 2, palette: 1, font: 2 }],
          lines: [
            {
              id: "l1",
              x1: 0,
              y1: 0,
              x2: 100,
              y2: 100,
              palette: 4,
              style: 1,
              mids: [[50, 60]],
            },
          ],
          strokes: [{ id: "s1", points: [[0, 0], [1, 1]], palette: 5 }],
          images: [
            { id: "img1", src: "flowgo-media/abc.png", x: 5, y: 6, width: 480, height: 360 },
          ],
        },
        // A map may omit every optional collection.
        { path: "/", boxes: [], edges: [] },
      ],
    };
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
  });
});
