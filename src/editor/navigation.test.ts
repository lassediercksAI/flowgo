// @vitest-environment jsdom
//
// Submap navigation: path parsing/normalisation, the hash <-> path
// round trip, go-up/enter-submap arithmetic, breadcrumb derivation,
// and navigateTo's pushState-vs-replaceState discipline.
//
// Two constraints shape the harness:
//
//   • jsdom's history/hash support is real but shallow: pushState /
//     replaceState update location.hash synchronously, but there is no
//     history *traversal* (no reliable back()/forward() event flow).
//     So back/forward is tested the way the module actually sees it —
//     set the hash without an event (replaceState), then dispatch a
//     synthetic `hashchange` — which is byte-for-byte what a browser
//     delivers after the traversal it performs internally.
//
//   • navigation.ts holds module state (wired bindings, the debounced
//     view-sync timer) and viewport.ts holds the live viewport. Fake
//     timers are on for EVERY test, because navigateTo → recenter →
//     applyViewport schedules a 200ms URL-sync timer as a side effect;
//     with real timers that timer would fire mid-way through a LATER
//     test and rewrite the hash under it.
//
// jsdom swallows listener exceptions into a window 'error' event, so a
// throw inside the real hashchange listener is trapped and re-asserted
// (same hatch as touch-link.test.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyURLView,
  attachNavigationListeners,
  buildViewQueryFrom,
  childPath,
  decodeHashPath,
  emptyMap,
  ensureMap,
  enterSubmap,
  goUp,
  navigateTo,
  normalizePath,
  parentPath,
  parseViewQuery,
  readPathFromURL,
  readViewFromURL,
  renderPath,
  resolveBreadcrumbs,
  splitHashString,
  wireNavigation,
} from "./navigation.ts";
import { applyViewport, MAX_SCALE, MIN_SCALE, viewport } from "./viewport.ts";

// ── harness state the bindings close over ──────────────────────────
interface TestMap {
  path: string;
  boxes?: Array<{ id: string; label?: string; x?: number; y?: number }>;
  edges?: unknown[];
  texts?: unknown[];
  lines?: unknown[];
  strokes?: unknown[];
  images?: unknown[];
}
let graph: { maps: TestMap[] } = { maps: [] };
let currentPath = "/";
let currentMap: TestMap | null = null;
const calls = { clearSelected: 0, clearSelectedEdge: 0, renderAll: 0 };
let listenerError: unknown = null;

const div = (id: string): HTMLElement => {
  const d = document.createElement("div");
  d.id = id;
  document.body.appendChild(d);
  return d;
};

// index.html ids that renderPath and applyViewport reach for. Rebuilt
// per test so display/class writes can't leak between tests.
const buildDom = (): void => {
  document.body.innerHTML = "";
  document.body.className = "";
  for (const id of [
    "path", "toolbar", "upBtn",
    "canvas", "edge-label-layer", "bg-layer",
    "line-layer", "stroke-layer", "edge-layer", "ghost-line",
  ]) {
    div(id);
  }
};

beforeAll(() => {
  window.addEventListener("error", (e) => {
    listenerError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
    e.preventDefault();
  });
  wireNavigation({
    getGraph: () => graph,
    getCurrentPath: () => currentPath,
    setCurrentPath: (p) => { currentPath = p; },
    setCurrentMap: (m) => { currentMap = m as TestMap; },
    clearSelected: () => { calls.clearSelected++; },
    clearSelectedEdge: () => { calls.clearSelectedEdge++; },
    renderAll: () => { calls.renderAll++; },
  });
  // Installs the real hashchange listener AND wires viewport→URL sync.
  // Once for the whole file — a second call would double the listener.
  attachNavigationListeners();
});

beforeEach(() => {
  // Fake timers FIRST: everything below may schedule the sync timer.
  vi.useFakeTimers();
  buildDom();
  graph = { maps: [] };
  currentPath = "/";
  currentMap = null;
  calls.clearSelected = 0;
  calls.clearSelectedEdge = 0;
  calls.renderAll = 0;
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  history.replaceState(null, "", "#/");
  listenerError = null;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(listenerError).toBeNull();
});

// Set the hash WITHOUT an event (replaceState never fires hashchange),
// then deliver the event by hand — the deterministic stand-in for a
// browser back/forward or address-bar edit.
const arriveAtHash = (h: string): void => {
  history.replaceState(null, "", h);
  window.dispatchEvent(new Event("hashchange"));
};

// ── pure path arithmetic ───────────────────────────────────────────

describe("splitHashString", () => {
  it("splits '#<path>?<query>' into its two halves", () => {
    expect(splitHashString("#/a/b?z=2&x=3")).toEqual({ path: "/a/b", query: "z=2&x=3" });
  });

  it("handles a bare path, an empty hash, and a lone '#'", () => {
    expect(splitHashString("#/a")).toEqual({ path: "/a", query: "" });
    expect(splitHashString("")).toEqual({ path: "", query: "" });
    expect(splitHashString("#")).toEqual({ path: "", query: "" });
  });

  it("splits on the FIRST '?' so query values may contain '?'", () => {
    expect(splitHashString("#/a?x=1?y=2")).toEqual({ path: "/a", query: "x=1?y=2" });
  });

  it("tolerates input without the leading '#'", () => {
    expect(splitHashString("/a?z=1")).toEqual({ path: "/a", query: "z=1" });
  });
});

describe("normalizePath", () => {
  it("maps the empty fragment to the root", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("grows a leading slash onto a hand-typed 'a/b'", () => {
    expect(normalizePath("a/b")).toBe("/a/b");
  });

  it("leaves an already-rooted path alone", () => {
    expect(normalizePath("/a/b")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("childPath / parentPath", () => {
  it("appends a segment without doubling the root slash", () => {
    expect(childPath("/", "b1")).toBe("/b1");
    expect(childPath("/a", "b2")).toBe("/a/b2");
    expect(childPath("/a/b", "c")).toBe("/a/b/c");
  });

  it("parentPath drops exactly one level", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
    expect(parentPath("/a/b")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
  });

  it("parentPath is total: root, trailing slashes and doubled slashes all land safely", () => {
    expect(parentPath("/")).toBe("/");
    expect(parentPath("")).toBe("/");
    expect(parentPath("/a/")).toBe("/"); // trailing slash is not a segment
    expect(parentPath("//a//b//")).toBe("/a"); // filter(Boolean) eats empties
  });

  it("round-trips: parentPath(childPath(p, id)) === p for canonical paths", () => {
    for (const p of ["/", "/a", "/a/b/c"]) {
      expect(parentPath(childPath(p, "zz"))).toBe(p);
    }
  });
});

// ── view-query parsing / serialising ───────────────────────────────

describe("parseViewQuery", () => {
  it("returns null for an absent query", () => {
    expect(parseViewQuery("")).toBeNull();
  });

  it("parses z/x/y, clamping z into the shared scale window", () => {
    expect(parseViewQuery("z=2&x=30&y=-40")).toEqual({ s: 2, x: 30, y: -40 });
    // Deliberately against viewport.ts's exported bounds, not
    // literals — the clamp windows drifting apart is the bug.
    expect(parseViewQuery("z=9999")).toEqual({ s: MAX_SCALE });
    expect(parseViewQuery("z=0.0001")).toEqual({ s: MIN_SCALE });
  });

  it("clamps a malformed bookmark's translate to ±1e6 instead of landing at infinity", () => {
    expect(parseViewQuery("x=1e308")).toEqual({ x: 1_000_000 });
    expect(parseViewQuery("y=-1e308")).toEqual({ y: -1_000_000 });
  });

  it("treats empty values as missing — '?z=' must not clamp the user to MIN_SCALE", () => {
    // Number("") === 0 is the trap this rule exists for.
    expect(parseViewQuery("z=&x=&y=")).toBeNull();
    expect(parseViewQuery("z=&x=5")).toEqual({ x: 5 });
  });

  it("ignores non-finite garbage but keeps the parseable fields", () => {
    expect(parseViewQuery("z=abc&x=7")).toEqual({ x: 7 });
    expect(parseViewQuery("z=NaN&x=Infinity")).toBeNull();
  });

  it("supports any partial combination", () => {
    expect(parseViewQuery("y=12")).toEqual({ y: 12 });
    expect(parseViewQuery("z=1.5&y=3")).toEqual({ s: 1.5, y: 3 });
  });
});

describe("buildViewQueryFrom", () => {
  it("omits defaults entirely so clean URLs stay clean", () => {
    expect(buildViewQueryFrom({ x: 0, y: 0, s: 1 })).toBe("");
  });

  it("formats s to 3 decimals and rounds x/y to integers", () => {
    expect(buildViewQueryFrom({ x: 10.6, y: -3.2, s: 1 })).toBe("?x=11&y=-3");
    expect(buildViewQueryFrom({ x: 0, y: 0, s: 2 })).toBe("?z=2.000");
    expect(buildViewQueryFrom({ x: 5, y: 7, s: 1.5 })).toBe("?z=1.500&x=5&y=7");
  });

  it("round-trips through parseViewQuery", () => {
    const q = buildViewQueryFrom({ x: -120, y: 60, s: 2.5 });
    expect(parseViewQuery(q.slice(1))).toEqual({ s: 2.5, x: -120, y: 60 });
  });
});

// ── URL readers against the live location ──────────────────────────

describe("readPathFromURL / readViewFromURL", () => {
  it("reads the path half of the hash, ignoring view params", () => {
    history.replaceState(null, "", "#/a/b?z=2&x=10");
    expect(readPathFromURL()).toBe("/a/b");
    expect(readViewFromURL()).toEqual({ s: 2, x: 10 });
  });

  it("defaults to the root for a missing or bare hash", () => {
    history.replaceState(null, "", location.pathname); // no hash at all
    expect(readPathFromURL()).toBe("/");
    expect(readViewFromURL()).toBeNull();
    history.replaceState(null, "", "#/");
    expect(readPathFromURL()).toBe("/");
  });

  it("normalises a hand-typed '#a/b' to '/a/b'", () => {
    history.replaceState(null, "", "#a/b");
    expect(readPathFromURL()).toBe("/a/b");
  });
});

// ── percent-encoded ids in the hash ────────────────────────────────
//
// location.hash percent-encodes on READ what navigateTo wrote raw, so
// every path read must decode or round-trips break (duplicate history
// entries, phantom submaps at the encoded path). Regression tests for
// the sweep-triage fix — the older tests above only used URL-safe ids
// and pinned this path indirectly.

describe("decodeHashPath", () => {
  it("decodes percent sequences and leaves safe strings alone", () => {
    expect(decodeHashPath("/caf%C3%A9")).toBe("/café");
    expect(decodeHashPath("/a%20b")).toBe("/a b");
    expect(decodeHashPath("/plain")).toBe("/plain");
  });

  it("falls back to the raw string for malformed % sequences instead of throwing", () => {
    expect(decodeHashPath("/50%")).toBe("/50%");
    expect(decodeHashPath("/50%off")).toBe("/50%off");
  });
});

describe("URL-encodable ids survive the hash round-trip", () => {
  it("readPathFromURL decodes what location.hash re-encoded", () => {
    // jsdom (like real browsers) percent-encodes the fragment on read.
    history.replaceState(null, "", "#/café bar");
    expect(location.hash).toBe("#/caf%C3%A9%20bar"); // the trap
    expect(readPathFromURL()).toBe("/café bar");
  });

  it("a malformed hand-typed hash reads as its raw self, not a throw", () => {
    history.replaceState(null, "", "#/50%");
    expect(readPathFromURL()).toBe("/50%");
  });

  it("re-navigating to an encodable path touches history not at all (no duplicate entries)", () => {
    navigateTo("/café bar");
    expect(currentPath).toBe("/café bar");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    // Before the decode fix this read the encoded hash, called it a
    // path CHANGE, and pushed a second history entry per navigateTo.
    navigateTo("/café bar");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("hashchange (back/forward) delivers the ENCODED form and lands on the SAME map — no phantom submap", () => {
    navigateTo("/mötley");
    navigateTo("/");
    // Browser "back" re-delivers the hash percent-encoded.
    arriveAtHash("#/m%C3%B6tley");
    expect(currentPath).toBe("/mötley");
    // Before the fix a second, empty map appeared at "/m%C3%B6tley".
    expect(graph.maps.filter((m) => m.path.includes("tley"))).toHaveLength(1);
    expect(graph.maps.map((m) => m.path)).toContain("/mötley");
  });

  it("the debounced view sync skips the write when only the encoding differs", () => {
    navigateTo("/a b");
    viewport.s = 2;
    applyViewport();
    vi.advanceTimersByTime(200);
    expect(readPathFromURL()).toBe("/a b");
    const replace = vi.spyOn(history, "replaceState");
    applyViewport(); // no viewport change since the last sync
    vi.advanceTimersByTime(200);
    // A byte comparison of raw-vs-encoded hash would replaceState on
    // every tick here.
    expect(replace).not.toHaveBeenCalled();
  });
});

// ── map bookkeeping ────────────────────────────────────────────────

describe("emptyMap", () => {
  it("carries every renderer-facing container, empty", () => {
    const m = emptyMap("/x");
    expect(m).toEqual({
      path: "/x", boxes: [], edges: [], texts: [], lines: [], strokes: [], images: [],
    });
  });

  it("mints fresh arrays per call — shared containers would alias maps into each other", () => {
    expect(emptyMap("/a").boxes).not.toBe(emptyMap("/b").boxes);
  });
});

describe("ensureMap", () => {
  it("creates and registers a missing map", () => {
    const m = ensureMap("/new");
    expect(graph.maps).toContain(m);
    expect(m.path).toBe("/new");
    expect(m.boxes).toEqual([]);
  });

  it("is idempotent: same reference, no duplicate registration", () => {
    const a = ensureMap("/p");
    const b = ensureMap("/p");
    expect(a).toBe(b);
    expect(graph.maps.filter((m) => m.path === "/p").length).toBe(1);
  });

  it("backfills the containers Go's JSON encoder omitted as nil", () => {
    graph.maps.push({ path: "/served" }); // as /state would deliver it
    const m = ensureMap("/served");
    expect(m).toBe(graph.maps[0]);
    for (const k of ["boxes", "edges", "texts", "lines", "strokes", "images"] as const) {
      expect(m[k], k).toEqual([]);
    }
  });

  it("does not clobber containers that already have content", () => {
    graph.maps.push({ path: "/full", boxes: [{ id: "b1", x: 0, y: 0 }] });
    expect(ensureMap("/full").boxes).toHaveLength(1);
  });

  it("throws a wiring error when used before wireNavigation()", async () => {
    // Fresh module copy so the statically-imported, wired instance
    // stays untouched — module-level `bindings` is the state under test.
    vi.resetModules();
    const fresh = await import("./navigation.ts");
    expect(() => fresh.ensureMap("/")).toThrow(/wireNavigation/);
  });
});

// ── breadcrumb derivation ──────────────────────────────────────────

describe("resolveBreadcrumbs", () => {
  const maps = [
    { path: "/", boxes: [{ id: "a", label: "Alpha" }, { id: "w", label: "   " }] },
    { path: "/a", boxes: [{ id: "b", label: "  Beta  " }] },
  ];

  it("is empty at the root", () => {
    expect(resolveBreadcrumbs(maps, "/")).toEqual([]);
  });

  it("resolves each segment's label from the map ONE LEVEL UP", () => {
    expect(resolveBreadcrumbs(maps, "/a/b")).toEqual([
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" }, // trimmed
    ]);
  });

  it("falls back to the raw id for orphans, missing maps, and blank labels", () => {
    // "w" exists but its label is whitespace-only; "/w" has no map of
    // its own; "zz" appears in no parent map at all.
    expect(resolveBreadcrumbs(maps, "/w/zz")).toEqual([
      { id: "w", label: "w" },
      { id: "zz", label: "zz" },
    ]);
  });

  it("tolerates maps with no boxes container", () => {
    expect(resolveBreadcrumbs([{ path: "/" }], "/x")).toEqual([{ id: "x", label: "x" }]);
  });

  it("resolves deep nesting parent-by-parent, not from the root map alone", () => {
    const deep = [
      { path: "/", boxes: [{ id: "a", label: "A" }] },
      { path: "/a", boxes: [{ id: "b", label: "B" }] },
      { path: "/a/b", boxes: [{ id: "c", label: "C" }] },
    ];
    expect(resolveBreadcrumbs(deep, "/a/b/c").map((r) => r.label)).toEqual(["A", "B", "C"]);
  });
});

// ── navigateTo: state, history discipline, viewport ────────────────

describe("navigateTo", () => {
  it("sets path + map, clears selection, renders, and pushes ONE history entry", () => {
    const push = vi.spyOn(history, "pushState");
    navigateTo("/x");
    expect(currentPath).toBe("/x");
    expect(currentMap).toBe(graph.maps.find((m) => m.path === "/x"));
    expect(calls.clearSelected).toBe(1);
    expect(calls.clearSelectedEdge).toBe(1);
    expect(calls.renderAll).toBe(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("#/x");
  });

  it("re-navigating to the current path with an identical hash touches history not at all", () => {
    navigateTo("/x");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    navigateTo("/x");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("same path but changed view: replaceState, never pushState — wheel ticks must not pollute history", () => {
    navigateTo("/x");
    viewport.s = 2; // zoom changed since the hash was written
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");
    navigateTo("/x");
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("#/x?z=2.000");
  });

  it("recenters by default (empty map → origin)", () => {
    viewport.x = 500;
    viewport.y = -300;
    navigateTo("/fresh");
    expect(viewport.x).toBe(0);
    expect(viewport.y).toBe(0);
  });

  it("keepViewport preserves the camera and bakes it into the hash", () => {
    viewport.x = 50;
    viewport.y = 60;
    viewport.s = 2;
    navigateTo("/kv", { keepViewport: true });
    expect(viewport).toEqual({ x: 50, y: 60, s: 2 });
    expect(location.hash).toBe("#/kv?z=2.000&x=50&y=60");
  });

  it("writes the hash from the POST-recenter viewport, so bookmarks restore what is on screen", () => {
    viewport.s = 2; // zoom is sticky across navigation; translate is not
    viewport.x = 999;
    navigateTo("/y");
    expect(location.hash).toBe("#/y?z=2.000");
  });
});

describe("enterSubmap / goUp", () => {
  it("enterSubmap descends from the root and from a nested level", () => {
    enterSubmap("b7");
    expect(currentPath).toBe("/b7");
    enterSubmap("c2");
    expect(currentPath).toBe("/b7/c2");
    expect(location.hash).toBe("#/b7/c2");
  });

  it("goUp walks one level at a time back to the root", () => {
    navigateTo("/a/b/c");
    goUp();
    expect(currentPath).toBe("/a/b");
    goUp();
    expect(currentPath).toBe("/a");
    goUp();
    expect(currentPath).toBe("/");
  });

  it("goUp at the root is a complete no-op — no render, no history", () => {
    const push = vi.spyOn(history, "pushState");
    const renders = calls.renderAll;
    goUp();
    expect(currentPath).toBe("/");
    expect(calls.renderAll).toBe(renders);
    expect(push).not.toHaveBeenCalled();
  });
});

// ── renderPath: breadcrumb DOM ─────────────────────────────────────

describe("renderPath", () => {
  const seed = (): void => {
    // Boxes need coordinates: navigateTo recenters on the first box,
    // and an x/y-less fixture would drive the viewport (and the URL
    // query) to NaN.
    graph.maps = [
      { path: "/", boxes: [{ id: "a", label: "Alpha", x: 0, y: 0 }] },
      { path: "/a", boxes: [{ id: "b", label: "Beta", x: 0, y: 0 }] },
      { path: "/a/b", boxes: [{ id: "c", label: "Gamma", x: 0, y: 0 }] },
    ];
  };

  it("hides the trail, toolbar and up-button at the root", () => {
    renderPath();
    expect(document.getElementById("path")!.style.display).toBe("none");
    expect(document.getElementById("toolbar")!.style.display).toBe("none");
    expect(document.getElementById("upBtn")!.style.display).toBe("none");
  });

  it("keeps the toolbar visible at the root in snapshot mode (download/reshare live there)", () => {
    document.body.classList.add("snapshot-mode");
    renderPath();
    expect(document.getElementById("toolbar")!.style.display).toBe("");
  });

  it("one level down: root seg + bold current label, no '…', up-button shown", () => {
    seed();
    navigateTo("/a");
    const el = document.getElementById("path")!;
    expect(el.style.display).toBe("");
    const segs = el.querySelectorAll(".seg");
    expect(segs.length).toBe(2);
    expect(segs[0]!.textContent).toBe("/");
    expect(segs[1]!.textContent).toBe("Alpha");
    expect((segs[1] as HTMLElement).style.fontWeight).toBe("bold");
    expect((segs[1] as HTMLElement).title).toBe("a"); // id in the tooltip
    expect(el.querySelector(".sep")).toBeNull();
    expect(document.getElementById("upBtn")!.style.display).toBe("");
    expect(document.getElementById("toolbar")!.style.display).toBe("");
  });

  it("deep paths compress: intermediates collapse into '…' whose tooltip lists them", () => {
    seed();
    navigateTo("/a/b/c");
    const el = document.getElementById("path")!;
    const sep = el.querySelector(".sep")!;
    expect(sep.textContent).toBe(" … / ");
    expect((sep as HTMLElement).title).toBe("Alpha / Beta");
    const segs = el.querySelectorAll(".seg");
    expect(segs.length).toBe(2); // root + current only, never the middles
    expect(segs[1]!.textContent).toBe("Gamma");
  });

  it("falls back to the raw id when no parent box carries a label", () => {
    navigateTo("/ghost");
    const segs = document.getElementById("path")!.querySelectorAll(".seg");
    expect(segs[1]!.textContent).toBe("ghost");
  });

  it("clicking the root seg navigates home", () => {
    seed();
    navigateTo("/a/b");
    const root = document.getElementById("path")!.querySelector(".seg") as HTMLElement;
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(currentPath).toBe("/");
    // The hash's path half is home; recenter on the root map's box
    // legitimately adds view params, so compare paths, not bytes.
    expect(readPathFromURL()).toBe("/");
  });

  it("re-renders idempotently instead of appending duplicate segs", () => {
    seed();
    navigateTo("/a");
    renderPath();
    renderPath();
    expect(document.getElementById("path")!.querySelectorAll(".seg").length).toBe(2);
  });

  it("survives a missing #path element (snapshot page has no trail)", () => {
    document.getElementById("path")!.remove();
    expect(() => renderPath()).not.toThrow();
  });
});

// ── hashchange: back/forward and address-bar edits ─────────────────

describe("hashchange handling (attachNavigationListeners)", () => {
  it("a path-only hash navigates and recenters", () => {
    viewport.x = 77;
    arriveAtHash("#/sub");
    expect(currentPath).toBe("/sub");
    expect(calls.renderAll).toBe(1);
    expect(viewport.x).toBe(0); // recentered — no view in the URL
  });

  it("a path+view hash restores the camera INSTEAD of recentering", () => {
    arriveAtHash("#/sub?z=2&x=30&y=-40");
    expect(currentPath).toBe("/sub");
    expect(viewport).toEqual({ s: 2, x: 30, y: -40 });
  });

  it("same map, view-only change: applies the view without re-navigating", () => {
    const push = vi.spyOn(history, "pushState");
    arriveAtHash("#/?z=3");
    expect(currentPath).toBe("/");
    expect(viewport.s).toBe(3);
    expect(calls.renderAll).toBe(0); // no navigateTo happened
    expect(push).not.toHaveBeenCalled();
  });

  it("a hashchange that lands on the current path with no view is inert", () => {
    arriveAtHash("#/");
    expect(calls.renderAll).toBe(0);
  });

  it("walks a back/forward sequence consistently", () => {
    navigateTo("/a");
    navigateTo("/a/b");
    // Browser "back": the hash flips and hashchange fires.
    arriveAtHash("#/a");
    expect(currentPath).toBe("/a");
    // Browser "forward".
    arriveAtHash("#/a/b");
    expect(currentPath).toBe("/a/b");
    // Back twice, to the root.
    arriveAtHash("#/a");
    arriveAtHash("#/");
    expect(currentPath).toBe("/");
  });
});

// ── viewport → URL sync (debounced replaceState) ───────────────────

describe("view sync to URL", () => {
  it("debounces pan/zoom into ONE replaceState with rounded params", () => {
    navigateTo("/m");
    const replace = vi.spyOn(history, "replaceState");
    // A 3-tick drag: every applyViewport re-arms the 200ms timer.
    viewport.x = 100.2;
    applyViewport();
    viewport.x = 110.4;
    applyViewport();
    viewport.x = 123.7;
    applyViewport();
    expect(replace).not.toHaveBeenCalled(); // nothing until the debounce
    vi.advanceTimersByTime(200);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("#/m?x=124"); // Math.round, integers only
  });

  it("writes z to three decimals and skips the write when the hash already matches", () => {
    navigateTo("/m");
    viewport.s = 2.5;
    applyViewport();
    vi.advanceTimersByTime(200);
    expect(location.hash).toBe("#/m?z=2.500");
    const replace = vi.spyOn(history, "replaceState");
    applyViewport(); // no viewport change since the last sync
    vi.advanceTimersByTime(200);
    expect(replace).not.toHaveBeenCalled();
  });

  it("navigateTo cancels a pending sync so the old map's timer can't fire into the new URL", () => {
    navigateTo("/old");
    viewport.x = 500;
    applyViewport(); // timer armed for /old's view
    navigateTo("/new"); // cancels it; recenter re-arms with /new's state
    expect(location.hash).toBe("#/new");
    vi.advanceTimersByTime(1000);
    // Whatever fired afterwards must describe /new, never /old.
    expect(location.hash).toBe("#/new");
    expect(currentPath).toBe("/new");
  });
});

// ── applyURLView ───────────────────────────────────────────────────

describe("applyURLView", () => {
  it("applies only the fields the URL specified", () => {
    viewport.x = 11;
    viewport.y = 22;
    viewport.s = 1.5;
    applyURLView({ x: 99 });
    expect(viewport).toEqual({ x: 99, y: 22, s: 1.5 });
  });

  it("clamps the scale through the shared window", () => {
    applyURLView({ s: 1000 });
    expect(viewport.s).toBe(MAX_SCALE);
    applyURLView({ s: 0 });
    expect(viewport.s).toBe(MIN_SCALE);
  });
});
