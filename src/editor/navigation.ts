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

import { recenter } from "./viewport.ts";

interface MapLike {
  path: string;
  boxes?: unknown[];
  edges?: unknown[];
  texts?: unknown[];
  lines?: unknown[];
  strokes?: unknown[];
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
  return m;
};

export const readPathFromURL = (): string => {
  let h = location.hash || "";
  if (h.startsWith("#")) h = h.slice(1);
  if (!h) return "/";
  if (!h.startsWith("/")) h = "/" + h;
  return h;
};

export interface SetPathOptions {
  readonly keepViewport?: boolean;
}

export const navigateTo = (p: string, opts?: SetPathOptions): void => {
  const keepViewport = opts?.keepViewport ?? false;
  const b = must();
  b.setCurrentPath(p);
  b.setCurrentMap(ensureMap(p));
  b.clearSelected();
  b.clearSelectedEdge();
  b.renderAll();
  renderPath();
  if (!keepViewport) recenter(ensureMap(p) as Parameters<typeof recenter>[0]);
  // Persist the current submap path in the URL hash so the location is
  // bookmarkable and the browser back/forward stack walks navigation.
  const newHash = "#" + p;
  if (location.hash !== newHash) {
    history.pushState(null, "", newHash);
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
// buttons land on the right submap.
export const attachNavigationListeners = (): void => {
  window.addEventListener("hashchange", () => {
    const p = readPathFromURL();
    if (p !== must().getCurrentPath()) navigateTo(p);
  });
};
