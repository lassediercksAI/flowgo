// Path navigation: which submap is currently visible, the breadcrumb
// trail at the top, and the URL-hash sync that makes navigation
// bookmarkable. The module is fully imperative — DOM-touching — but
// confined: every external dependency comes through wireNavigation().
//
// `setCurrentPath` is the single source of submap transitions. Other
// modules call setCurrentPath() rather than mutating currentPath
// themselves, which keeps the renderAll / renderPath / recenter
// triplet ordered correctly and the URL-hash + history.pushState
// invariants maintained.

import {
  applyViewport,
  clampScale,
  recenter,
  viewport,
  wireViewportSync,
} from "./viewport.ts";

interface MapLike {
  path: string;
  boxes?: unknown[];
  edges?: unknown[];
  texts?: unknown[];
  lines?: unknown[];
  strokes?: unknown[];
  images?: unknown[];
}

interface GraphLike {
  maps: MapLike[];
}

interface NavBindings {
  readonly getGraph: () => GraphLike;
  readonly getCurrentPath: () => string;
  readonly setCurrentPath: (p: string) => void;
  readonly setCurrentMap: (m: MapLike) => void;
  readonly clearSelected: () => void;
  readonly clearSelectedEdge: () => void;
  readonly renderAll: () => void;
}

let bindings: NavBindings | null = null;
const must = (): NavBindings => {
  if (!bindings) throw new Error("navigation: wireNavigation() not called");
  return bindings;
};

export const wireNavigation = (b: NavBindings): void => {
  bindings = b;
};

// A map with every container present and empty.
//
// THE renderer-facing shape: render.ts and culling.ts read
// map.boxes/texts/lines/edges without nil checks, on the invariant
// that every map they see has been through ensureMap. main.ts's
// pre-load placeholder is the one map that never has been, so it
// takes its shape from here instead of an inline literal — the two
// used to drift, and the placeholder was missing `texts` entirely
// (brain#24d: a wheel-pan or window resize before /state answered
// reached updateCulling and threw on map.texts.length).
export const emptyMap = (path: string): MapLike => ({
  path,
  boxes: [],
  edges: [],
  texts: [],
  lines: [],
  strokes: [],
  images: [],
});

// Idempotent map lookup: ensures the named map exists in `graph.maps`
// and returns it with every container slice non-null. Other modules
// receive the resolved map so they can `push` onto its arrays without
// nil checks.
export const ensureMap = (path: string): MapLike => {
  const g = must().getGraph();
  let m = g.maps.find((x) => x.path === path);
  if (!m) {
    m = emptyMap(path);
    g.maps.push(m);
  }
  // Existing maps come from /state, where Go omits nil slices — fill
  // the same key set emptyMap() defines. render-culling.test.ts pins
  // the two against each other so a seventh container can't land in
  // one and not the other.
  m.boxes ??= [];
  m.edges ??= [];
  m.texts ??= [];
  m.lines ??= [];
  m.strokes ??= [];
  m.images ??= [];
  return m;
};

// Hash format: "#<path>?z=<scale>&x=<vx>&y=<vy>" — query-string syntax
// inside the fragment so bookmarks restore both the current submap and
// the view (pan + zoom). The view params are all optional; "#/" still
// works as a bare path. Parsing returns just the path here; view
// params are handled by readViewFromURL().
// Pure half of the hash parser: everything after this line is string
// math with no `location` access, so it can be pinned in node-env
// tests without a jsdom URL dance.
export const splitHashString = (hash: string): { path: string; query: string } => {
  let h = hash || "";
  if (h.startsWith("#")) h = h.slice(1);
  const q = h.indexOf("?");
  const path = q === -1 ? h : h.slice(0, q);
  const query = q === -1 ? "" : h.slice(q + 1);
  return { path, query };
};

const splitHash = (): { path: string; query: string } =>
  splitHashString(location.hash);

// Path-shape normalisation: an empty fragment is the root, and a bare
// "a/b" (hand-typed bookmark) grows its leading slash.
export const normalizePath = (path: string): string => {
  if (!path) return "/";
  if (!path.startsWith("/")) return "/" + path;
  return path;
};

export const readPathFromURL = (): string => normalizePath(splitHash().path);

// Parses ?z=&x=&y= out of the hash. Any combination is allowed —
// callers should treat `null` fields as "leave at recenter default".
// Returns null when no view params were present at all so the caller
// can fall back to the recenter path with no extra plumbing.
// Limit URL-supplied translate values to a sane range. CSS transforms
// stop being usable well before this, but a malformed bookmark with
// `?x=1e308` would land the viewport at infinity. ±1e6 covers any
// realistic map ten times over.
const MAX_TRANSLATE = 1_000_000;

// Pure query-string → view-params parser. Kept separate from
// readViewFromURL so the clamping / empty-value rules are testable
// without touching location.hash.
export const parseViewQuery = (
  query: string,
): { s?: number; x?: number; y?: number } | null => {
  if (!query) return null;
  const params = new URLSearchParams(query);
  const out: { s?: number; x?: number; y?: number } = {};
  const z = params.get("z");
  const x = params.get("x");
  const y = params.get("y");
  // Empty values (`?z=`) parse as `Number("") === 0`, which would
  // silently clamp users to 50% scale or zero translate. Treat the
  // empty string the same as a missing key.
  if (z !== null && z !== "") {
    const n = Number(z);
    if (Number.isFinite(n)) out.s = clampScale(n);
  }
  if (x !== null && x !== "") {
    const n = Number(x);
    if (Number.isFinite(n)) out.x = Math.max(-MAX_TRANSLATE, Math.min(MAX_TRANSLATE, n));
  }
  if (y !== null && y !== "") {
    const n = Number(y);
    if (Number.isFinite(n)) out.y = Math.max(-MAX_TRANSLATE, Math.min(MAX_TRANSLATE, n));
  }
  if (out.s === undefined && out.x === undefined && out.y === undefined) {
    return null;
  }
  return out;
};

export const readViewFromURL = (): { s?: number; x?: number; y?: number } | null =>
  parseViewQuery(splitHash().query);

// Serialise current viewport to the query portion. Values that match
// defaults (s=1, x=0, y=0) are omitted to keep clean URLs clean. Only
// integers for x/y — sub-pixel precision doesn't survive a bookmark
// and just makes the URL ugly. Three decimal places for s covers the
// useful precision without trailing noise.
export const buildViewQueryFrom = (v: {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}): string => {
  const parts: string[] = [];
  if (v.s !== 1) parts.push(`z=${v.s.toFixed(3)}`);
  if (v.x !== 0) parts.push(`x=${Math.round(v.x)}`);
  if (v.y !== 0) parts.push(`y=${Math.round(v.y)}`);
  return parts.length === 0 ? "" : "?" + parts.join("&");
};

const buildViewQuery = (): string => buildViewQueryFrom(viewport);

// Debounced URL writer. Pan + zoom can fire 60 times a second during a
// drag; replaceState'ing on every tick is fine on modern browsers but
// looks janky in DevTools' URL log. 200ms is short enough that a
// reload right after letting go restores faithfully, long enough that
// idle drags don't spam history.replaceState.
let viewSyncTimer: number | null = null;
const VIEW_SYNC_DELAY_MS = 200;
const syncViewToURL = (): void => {
  if (viewSyncTimer !== null) clearTimeout(viewSyncTimer);
  viewSyncTimer = window.setTimeout(() => {
    viewSyncTimer = null;
    const path = bindings?.getCurrentPath() ?? "/";
    const next = "#" + path + buildViewQuery();
    if (location.hash !== next) {
      history.replaceState(history.state, "", next);
    }
  }, VIEW_SYNC_DELAY_MS);
};

export interface SetPathOptions {
  readonly keepViewport?: boolean;
}

export const navigateTo = (p: string, opts?: SetPathOptions): void => {
  // Cancel any pending pan/zoom URL sync from before this navigation
  // — letting it fire after navigateTo's own pushState would
  // replaceState the new path's hash with the *previous* map's view.
  if (viewSyncTimer !== null) {
    clearTimeout(viewSyncTimer);
    viewSyncTimer = null;
  }
  const keepViewport = opts?.keepViewport ?? false;
  const b = must();
  b.setCurrentPath(p);
  b.setCurrentMap(ensureMap(p));
  b.clearSelected();
  b.clearSelectedEdge();
  b.renderAll();
  renderPath();
  if (!keepViewport) {
    recenter(ensureMap(p) as Parameters<typeof recenter>[0]);
  } else {
    // recenter() is the only path that calls applyViewport() — when
    // we skip it (URL-restored view, or callers that just want to
    // preserve the camera through navigation) the new map still needs
    // a transform push so the CSS / SVG layers reflect viewport.x/y/s.
    applyViewport();
  }
  // Persist the current submap path + view (pan / zoom) in the URL
  // hash so the location is bookmarkable and the browser back/forward
  // stack walks navigation. pushState only when the path actually
  // changed — view-only changes go through replaceState in
  // syncViewToURL so we don't pollute history with every wheel tick.
  const newHash = "#" + p + buildViewQuery();
  const currentPath = splitHash().path || "/";
  if (currentPath !== p) {
    history.pushState(null, "", newHash);
  } else if (location.hash !== newHash) {
    history.replaceState(history.state, "", newHash);
  }
};

// Pure path arithmetic for the two hierarchy moves. childPath appends
// a segment (no double slash at root); parentPath drops the last
// segment and lands on "/" from any depth — including degenerate
// inputs like trailing slashes or "" (both normalise via
// filter(Boolean)).
export const childPath = (parent: string, boxId: string): string =>
  parent === "/" ? "/" + boxId : parent + "/" + boxId;

export const parentPath = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? "/" + parts.join("/") : "/";
};

export const enterSubmap = (boxId: string): void => {
  navigateTo(childPath(must().getCurrentPath(), boxId));
};

export const goUp = (): void => {
  const cur = must().getCurrentPath();
  if (cur === "/") return;
  navigateTo(parentPath(cur));
};

interface BoxWithLabel {
  readonly id: string;
  readonly label?: string;
}

// Breadcrumb derivation, pure over the graph snapshot: each segment id
// resolves to the label of the matching box one level UP (that is
// where a submap's display name lives), trimmed; raw id for orphans /
// blank labels. The root path yields [].
export const resolveBreadcrumbs = (
  maps: ReadonlyArray<{ readonly path: string; readonly boxes?: unknown[] }>,
  currentPath: string,
): Array<{ id: string; label: string }> => {
  const segs = currentPath === "/" ? [] : currentPath.split("/").filter(Boolean);
  let acc = "";
  let parent = "/";
  return segs.map((s) => {
    acc += "/" + s;
    const parentMap = maps.find((m) => m.path === parent);
    const parentBoxes = (parentMap?.boxes ?? []) as BoxWithLabel[];
    const parentBox = parentBoxes.find((bx) => bx.id === s);
    const label = (parentBox?.label && parentBox.label.trim()) || s;
    parent = acc;
    return { id: s, label };
  });
};

export const renderPath = (): void => {
  const b = must();
  const graph = b.getGraph();
  const currentPath = b.getCurrentPath();
  const el = document.getElementById("path");
  if (!el) return;
  el.innerHTML = "";
  const segs = currentPath === "/" ? [] : currentPath.split("/").filter(Boolean);
  el.style.display = segs.length === 0 ? "none" : "";
  // Hide the whole toolbar chrome at root unless snapshot mode is
  // showing the download/reshare buttons inside it.
  const toolbar = document.getElementById("toolbar");
  const snapshot = document.body.classList.contains("snapshot-mode");
  if (toolbar) toolbar.style.display = segs.length === 0 && !snapshot ? "none" : "";
  if (segs.length === 0) {
    const upBtn = document.getElementById("upBtn");
    if (upBtn) upBtn.style.display = "none";
    return;
  }
  // Resolve every segment id to its label by walking the parent maps
  // (labels come from the box in the level above; raw id for orphans).
  const resolved = resolveBreadcrumbs(graph.maps || [], currentPath);

  // Compressed trail: root and the current level only. Intermediate
  // levels collapse into a non-interactive "…" — deep paths would
  // otherwise crowd the centered toolbar, and the Up button already
  // walks the hierarchy one level at a time.
  const root = document.createElement("span");
  root.className = "seg";
  root.textContent = "/";
  root.title = "Back to the root map";
  root.addEventListener("click", () => navigateTo("/"));
  el.appendChild(root);

  if (resolved.length > 1) {
    const skip = document.createElement("span");
    skip.className = "sep";
    skip.textContent = " … / ";
    skip.title = resolved
      .slice(0, -1)
      .map((r) => r.label)
      .join(" / ");
    el.appendChild(skip);
  }

  const last = resolved[resolved.length - 1]!;
  const seg = document.createElement("span");
  seg.className = "seg";
  seg.textContent = last.label;
  seg.title = last.id;
  seg.style.fontWeight = "bold";
  seg.style.cursor = "default";
  el.appendChild(seg);
  const upBtn = document.getElementById("upBtn");
  if (upBtn) upBtn.style.display = currentPath === "/" ? "none" : "";
};

// Wire the browser's hashchange to navigateTo() so back/forward
// buttons land on the right submap, and install the viewport→URL
// sync so pan/zoom replaceState the view params into the hash.
export const attachNavigationListeners = (): void => {
  window.addEventListener("hashchange", () => {
    const p = readPathFromURL();
    const v = readViewFromURL();
    if (p !== must().getCurrentPath()) {
      // Path changed — let navigateTo do the full reload. When the
      // bookmark also pinned a view we apply it *before* navigateTo
      // so its keepViewport-skip-recenter branch renders against the
      // restored camera, then call applyViewport for the DOM push.
      if (v) {
        applyURLView(v);
        navigateTo(p, { keepViewport: true });
      } else {
        navigateTo(p);
      }
    } else if (v) {
      // Same map, hash changed (back/forward across view-only
      // snapshots). Apply the new view and push the transform.
      applyURLView(v);
      applyViewport();
    }
  });
  wireViewportSync(syncViewToURL);
};

// Apply parsed URL view params to the live viewport without losing
// the values the URL didn't specify. Exported so persistence.ts can
// call it on initial load before/around setCurrentPath.
export const applyURLView = (v: { s?: number; x?: number; y?: number }): void => {
  if (v.s !== undefined) viewport.s = clampScale(v.s);
  if (v.x !== undefined) viewport.x = v.x;
  if (v.y !== undefined) viewport.y = v.y;
};
