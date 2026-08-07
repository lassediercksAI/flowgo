// How the editor addresses the document it is editing (brain#272) —
// the DEFAULT half: nothing in the page URL names a document.
//
// That is `flowgo --host`, the CLI, serving one file at `/`. The bar
// is byte-identical URLs: the CLI's server matches on the path, so a
// stray "?" would be as broken as a wrong name. These assertions are
// on the literal strings for that reason, not on `MAP_ID === null`.
//
// The vitest environment for this repo is `node`, so `location` is
// undefined here — which is also the shape a downstream consumer
// importing this module server-side gets. The hosted half (?map=)
// needs a stubbed location before module evaluation and so lives in
// persistence-addressing-hosted.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAP_ID,
  dataURLFor,
  load,
  mapIDFrom,
  scheduleSave,
  wirePersistence,
} from "./persistence.ts";

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
  wirePersistence({
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

describe("nothing names a document — the CLI's single-file world", () => {
  it("has no document name", () => {
    expect(MAP_ID).toBeNull();
  });

  it("reads from exactly /state", async () => {
    await load();
    expect(urls).toEqual(["/state"]);
  });

  it("writes to exactly /save", async () => {
    scheduleSave();
    await vi.waitFor(() => expect(urls.length).toBe(1));
    expect(urls[0]).toBe("/save");
  });
});

describe("mapIDFrom", () => {
  it("reads the map param", () => {
    expect(mapIDFrom("?map=my-map")).toBe("my-map");
    expect(mapIDFrom("map=my-map")).toBe("my-map");
  });

  it("treats absent and empty alike — neither names a document", () => {
    expect(mapIDFrom("")).toBeNull();
    expect(mapIDFrom("?")).toBeNull();
    expect(mapIDFrom("?map=")).toBeNull();
  });

  it("ignores params that are not the document name", () => {
    // The cloud shell has carried ?collab=<secret> on the page URL
    // since brain#230, and the CLI's page may grow params of its own.
    expect(mapIDFrom("?collab=abc123")).toBeNull();
    expect(mapIDFrom("?collab=abc&map=m1")).toBe("m1");
  });

  it("decodes what a host encoded", () => {
    expect(mapIDFrom("?map=a%20b")).toBe("a b");
  });
});

describe("dataURLFor", () => {
  it("returns the path untouched when no document is named", () => {
    expect(dataURLFor(null, "/state")).toBe("/state");
    expect(dataURLFor(null, "/save")).toBe("/save");
  });

  it("appends the name", () => {
    expect(dataURLFor("my-map", "/state")).toBe("/state?map=my-map");
    expect(dataURLFor("my-map", "/save")).toBe("/save?map=my-map");
  });

  it("percent-encodes the name", () => {
    // A name that round-trips wrong would silently address a DIFFERENT
    // document — the one failure mode here that loses data rather than
    // erroring.
    expect(dataURLFor("a b&c=d", "/state")).toBe("/state?map=a%20b%26c%3Dd");
  });

  it("round-trips through mapIDFrom", () => {
    for (const name of ["m-1a2b3c4d", "a b&c=d", "ä-ü", "100%", "a+b", "a/b"]) {
      const url = dataURLFor(name, "/state");
      expect(mapIDFrom(url.slice(url.indexOf("?")))).toBe(name);
    }
  });
});
