// The failed-save contract (brain#25c measurement finding): the hosted
// server rejects over-limit bodies with 400 and saveBody used to say
// "saved" anyway — silent data loss dressed as success. These pin the
// three behaviors that close that hole: a non-2xx response surfaces as
// a failure status, a network error does too (previously an unhandled
// rejection), and a single trailing retry re-attempts and clears on
// success.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const statuses: string[] = [];
let responses: Array<{ ok: boolean; status: number }>;
let fetches = 0;

const setup = async () => {
  vi.resetModules();
  statuses.length = 0;
  fetches = 0;
  vi.stubGlobal("fetch", async () => {
    const r = responses[Math.min(fetches, responses.length - 1)]!;
    fetches++;
    return {
      ok: r.ok,
      status: r.status,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => "",
    };
  });
  const p = await import("./persistence.ts");
  p.wirePersistence({
    getGraph: () => ({ maps: [{ path: "/", boxes: [], edges: [], texts: [], lines: [] }] }),
    setGraph: () => {},
    setStatus: (s: string) => statuses.push(s),
  } as never);
  return p;
};

describe("saveBody failure surfacing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a rejected save says NOT saved instead of claiming success", async () => {
    responses = [{ ok: false, status: 400 }];
    const p = await setup();
    p.scheduleSave();
    await vi.runOnlyPendingTimersAsync();
    const last = statuses[statuses.length - 1]!;
    expect(last).toContain("NOT saved");
    expect(last).toContain("400");
    expect(statuses).not.toContain("saved");
  });

  it("a network error surfaces the same way, no unhandled rejection", async () => {
    const p = await (async () => {
      vi.resetModules();
      statuses.length = 0;
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("network down");
      });
      const mod = await import("./persistence.ts");
      mod.wirePersistence({
        getGraph: () => ({ maps: [{ path: "/", boxes: [], edges: [], texts: [], lines: [] }] }),
        setGraph: () => {},
        setStatus: (s: string) => statuses.push(s),
      } as never);
      return mod;
    })();
    p.scheduleSave();
    await vi.runOnlyPendingTimersAsync();
    expect(statuses[statuses.length - 1]).toContain("network");
  });

  it("the retry fires once and a later success clears to saved", async () => {
    responses = [
      { ok: false, status: 413 },
      { ok: true, status: 200 },
    ];
    const p = await setup();
    p.scheduleSave();
    await vi.runOnlyPendingTimersAsync(); // debounce → first (failing) save
    expect(statuses[statuses.length - 1]).toContain("NOT saved");
    await vi.advanceTimersByTimeAsync(5000); // retry window
    expect(fetches).toBe(2);
    expect(statuses[statuses.length - 1]).toBe("saved");
  });
});
