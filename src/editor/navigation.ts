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

// Idempotent map lookup: ensures the named map exists in `graph.maps`
// and returns it with every container slice non-null. Other modules
// receive the resolved map so they can `push` onto its arrays without
// nil checks.
export const ensureMap = (path: string): MapLike => {
  const g = must().getGraph();
  let m = g.maps.find((x) => x.path === path);
  if (!m) {
    m = { path, boxes: [], edges: [] };
    g.maps.push(m);
  }
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
const splitHash = (): { path: string; query: string } => {
  let h = location.hash || "";
  if (h.startsWith("#")) h = h.slice(1);
  const q = h.indexOf("?");
  const path = q === -1 ? h : h.slice(0, q);
  const query = q === -1 ? "" : h.slice(q + 1);
  return { path, query };
};

export const readPathFromURL = (): string => {
  const { path } = splitHash();
  if (!path) return "/";
  if (!path.startsWith("/")) return "/" + path;
  return path;
};

// Parses ?z=&x=&y= out of the hash. Any combination is allowed —
// callers should treat `null` fields as "leave at recenter default".
// Returns null when no view params were present at all so the caller
// can fall back to the recenter path with no extra plumbing.
// Limit URL-supplied translate values to a sane range. CSS transforms
// stop being usable well before this, but a malformed bookmark with
// `?x=1e308` would land the viewport at infinity. ±1e6 covers any
// realistic map ten times over.
const MAX_TRANSLATE = 1_000_000;

export const readViewFromURL = (): { s?: number; x?: number; y?: number } | null => {
  const { query } = splitHash();
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

// Serialise current viewport to the query portion. Values that match
// defaults (s=1, x=0, y=0) are omitted to keep clean URLs clean. Only
// integers for x/y — sub-pixel precision doesn't survive a bookmark
// and just makes the URL ugly. Three decimal places for s covers the
// useful precision without trailing noise.
const buildViewQuery = (): string => {
  const parts: string[] = [];
  if (viewport.s !== 1) parts.push(`z=${viewport.s.toFixed(3)}`);
  if (viewport.x !== 0) parts.push(`x=${Math.round(viewport.x)}`);
  if (viewport.y !== 0) parts.push(`y=${Math.round(viewport.y)}`);
  return parts.length === 0 ? "" : "?" + parts.join("&");
};

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

export const enterSubmap = (boxId: string): void => {
  const cur = must().getCurrentPath();
  navigateTo(cur === "/" ? "/" + boxId : cur + "/" + boxId);
};

export const goUp = (): void => {
  const cur = must().getCurrentPath();
  if (cur === "/") return;
  const parts = cur.split("/").filter(Boolean);
  parts.pop();
  navigateTo(parts.length ? "/" + parts.join("/") : "/");
};

interface BoxWithLabel {
  readonly id: string;
  readonly label?: string;
}

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
  const root = document.createElement("span");
  root.className = "seg";
  root.textContent = "/";
  root.addEventListener("click", () => navigateTo("/"));
  el.appendChild(root);
  let acc = "";
  let parentPath = "/";
  segs.forEach((s, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      el.appendChild(sep);
    }
    acc += "/" + s;
    const path = acc;
    // Resolve the segment id to its label by looking it up in the
    // parent map. Falls back to the raw id for orphans.
    const parentMap = (graph.maps || []).find((m) => m.path === parentPath);
    const parentBoxes = (parentMap?.boxes ?? []) as BoxWithLabel[];
    const parentBox = parentBoxes.find((bx) => bx.id === s);
    const label = (parentBox?.label && parentBox.label.trim()) || s;
    parentPath = path;
    const seg = document.createElement("span");
    seg.className = "seg";
    seg.textContent = label;
    seg.title = s;
    if (i < segs.length - 1) {
      seg.addEventListener("click", () => navigateTo(path));
    } else {
      seg.style.fontWeight = "bold";
      seg.style.cursor = "default";
    }
    el.appendChild(seg);
  });
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
