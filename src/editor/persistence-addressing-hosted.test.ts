// How the editor addresses the document it is editing (brain#272) —
// the HOSTED half: the page URL names a document with `?map=<name>`.
//
// The name has to reach every data request, reads and writes alike:
// a read that resolved to a different document than the write would
// lose the user's work rather than merely 404.
//
// MAP_ID is resolved once at module evaluation, so `location` must be
// stubbed before the import. That is why this is a separate file from
// persistence-addressing.test.ts (vi.resetModules() + a re-import of
// this module overflows the stack under the repo's Node).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("location", new URL("https://example.test/editor?map=my%20map"));

const persistence = await import("./persistence.ts");

type GraphLike = { maps: Array<{ path: string; boxes?: unknown[]; edges?: unknown[] }> };

const doc = (): GraphLike => ({ maps: [{ path: "/", boxes: [], edges: [] }] });

let urls: string[];

beforeEach(() => {
  urls = [];
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(String(url));
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(doc()),
    } as unknown as Response);
  });
  persistence.wirePersistence({
    getGraph: () => doc(),
    setGraph: () => {},
    serializeGraph: () => "",
    setCurrentPath: () => {},
    getCurrentPath: () => "/",
    readPathFromURL: () => "/",
    readViewFromURL: () => null,
    applyURLView: () => {},
    setStatus: () => {},
    clearSelected: () => {},
    clearSelectedEdge: () => {},
  });
});

describe("?map=<name>", () => {
  it("decodes the name from the page URL", () => {
    expect(persistence.MAP_ID).toBe("my map");
  });

  it("names the document on the initial read", async () => {
    await persistence.load();
    expect(urls).toEqual(["/state?map=my%20map"]);
  });

  it("names the document on the write", async () => {
    persistence.scheduleSave();
    await vi.waitFor(() => expect(urls.length).toBe(1));
    expect(urls[0]).toBe("/save?map=my%20map");
  });

  it("names the document when the live-events stream triggers a re-read", async () => {
    // refreshFromServer is the third data URL in the module and the
    // easiest to miss: a refresh that dropped the name would pull a
    // DIFFERENT document over what the user is looking at (brain#250).
    await persistence.load();
    urls = [];
    await persistence.refreshFromServer();
    expect(urls).toEqual(["/state?map=my%20map"]);
  });
});
