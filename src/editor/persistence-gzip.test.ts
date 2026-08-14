// The gzip capability gate (brain#25c): compression only against
// servers that advertised it on /state, only for bodies worth it, and
// the wire carries Content-Encoding so the server knows. Node ≥18 has
// CompressionStream, so the real compressor runs here.
import { afterEach, describe, expect, it, vi } from "vitest";

type Sent = { headers: Record<string, string>; body: unknown };

const boot = async (advertise: boolean) => {
  vi.resetModules();
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/save")) {
      sent.push({ headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
      return { ok: true, status: 200, headers: { get: () => null } };
    }
    // /state
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string) =>
          advertise && k === "X-Flowgo-Accept-Encoding" ? "gzip" : null,
      },
      json: async () => ({ maps: [{ path: "/", boxes: [], edges: [], texts: [], lines: [] }] }),
    };
  });
  const p = await import("./persistence.ts");
  const big = { maps: [{ path: "/", boxes: [] as unknown[], edges: [], texts: [], lines: [] }] };
  for (let i = 0; i < 3000; i++) {
    big.maps[0]!.boxes.push({ id: `b${i}`, label: `box number ${i} with some length to it`, x: i, y: i });
  }
  p.wirePersistence({
    getGraph: () => big,
    setGraph: () => {},
    setStatus: () => {},
  } as never);
  // Drive the capability note directly instead of load() — load wants
  // the full viewport/URL binding set, and the seam under test is just
  // "did /state advertise gzip".
  p.noteCapabilities({
    headers: {
      get: (k: string) =>
        advertise && k === "X-Flowgo-Accept-Encoding" ? "gzip" : null,
    },
  } as never);
  return { p, sent };
};

describe("gzip save capability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("compresses large bodies when the server advertised gzip", async () => {
    const { p, sent } = await boot(true);
    // Real timers on purpose: the compression path pipes through a
    // real CompressionStream, which fake timers would starve.
    p.scheduleSave();
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 4000 });
    expect(sent[0]!.headers["Content-Encoding"]).toBe("gzip");
    const blob = sent[0]!.body as Blob;
    const raw = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect([raw[0], raw[1]]).toEqual([0x1f, 0x8b]); // gzip magic
  });

  it("stays plain when the server never advertised", async () => {
    const { p, sent } = await boot(false);
    p.scheduleSave();
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 4000 });
    expect(sent[0]!.headers["Content-Encoding"]).toBeUndefined();
  });
});
