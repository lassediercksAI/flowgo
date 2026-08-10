// Self-contained, read-only .flowgo renderer for embedding outside the
// editor: Claude Artifacts, docs sites, Obsidian/VS Code plugins, a
// browser extension. One <script> tag (the bundle produced by
// `pnpm build:inline`, see vite.inline.config.ts) plus one call:
//
//   FlowgoInline.renderFlowgo(container, flowgoText)
//
// No network calls, no external CSS/fonts — everything this module
// needs is inlined here and injected as a single <style> tag on first
// use. Reuses the same pure geometry/graph helpers the interactive
// editor is built on (handle anchors, hex/shape sizing, palette
// resolution, stroke paths, the .flowgo parser) so a rendered map
// matches the editor's look; it does NOT reuse editor/render.ts
// directly, since that module is wired to selection state, drag
// handlers, and resize grips that a read-only view has no use for.
//
// Scope: read-only render, pan (drag) + zoom (wheel), optional submap
// drill-in via a breadcrumb. No editing.

import {
  hasSubmapContent,
  parseFlowgo,
  rectAnchor,
  resolveFont,
  resolvePalette,
  strokePathD,
  submapPathFor,
  type ConcreteGraph,
  type ConcreteMap,
} from "../index.ts";
import { fixedShapeSize } from "../graph/shape.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const STYLE_ID = "flowgo-inline-style";

const STYLE_CSS = `
.fgi-root { position: relative; overflow: hidden; width: 100%; height: 100%; min-height: 200px; background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; box-sizing: border-box; }
.fgi-root, .fgi-root * { box-sizing: border-box; }
.fgi-crumbs { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: flex; gap: 4px; padding: 6px 8px; font-size: 12px; color: #444; background: rgba(255,255,255,.85); border-bottom: 1px solid #e5e5e5; overflow-x: auto; white-space: nowrap; }
.fgi-crumbs button { border: none; background: none; padding: 2px 4px; font: inherit; color: #37f; cursor: pointer; border-radius: 3px; }
.fgi-crumbs button:hover { background: #eef; }
.fgi-crumbs span.fgi-crumb-sep { color: #bbb; }
.fgi-crumbs span.fgi-crumb-cur { padding: 2px 4px; color: #444; }
.fgi-viewport { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; }
.fgi-viewport.fgi-panning { cursor: grabbing; }
.fgi-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.fgi-svg { position: absolute; left: 0; top: 0; overflow: visible; width: 1px; height: 1px; z-index: 1; }
.fgi-layer { position: absolute; left: 0; top: 0; z-index: 2; }
.fgi-box { position: absolute; isolation: isolate; min-width: 80px; padding: 0.55em 0.85em; background: #fff; color: #333; border: 2px solid #333; border-radius: 6px; font-size: 14px; line-height: 1.25; text-align: center; white-space: pre-wrap; word-break: break-word; }
.fgi-box.fgi-has-submap { cursor: pointer; box-shadow: 4px 4px 0 0 #222; }
.fgi-box.fgi-sized { display: flex; align-items: center; justify-content: center; overflow: hidden; }
.fgi-box.fgi-hex { border: none; background: transparent; box-shadow: none; }
.fgi-box.fgi-hex::before, .fgi-box.fgi-hex::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
.fgi-box.fgi-hex::before { clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%); background: #333; z-index: -2; }
.fgi-box.fgi-hex::after { clip-path: polygon(25.48% 0.97%, 74.52% 0.97%, 99.01% 50%, 74.52% 99.03%, 25.48% 99.03%, 0.99% 50%); background: #fff; z-index: -1; }
.fgi-box.fgi-circle { border-radius: 50%; }
.fgi-box.fgi-tri { border: none; background: transparent; box-shadow: none; padding-top: 1.6em; }
.fgi-box.fgi-tri::before, .fgi-box.fgi-tri::after { content: ""; position: absolute; inset: 0; pointer-events: none; }
.fgi-box.fgi-tri::before { clip-path: polygon(50% 0%, 100% 100%, 0% 100%); background: #333; z-index: -2; }
.fgi-box.fgi-tri::after { clip-path: polygon(50% 2.88%, 97.84% 98.56%, 2.16% 98.56%); background: #fff; z-index: -1; }
.fgi-box.fgi-palette-2 { background: #bfdbfe; border-color: #1d4ed8; color: #1e3a8a; }
.fgi-box.fgi-palette-3 { background: #ddd6fe; border-color: #6d28d9; color: #4c1d95; }
.fgi-box.fgi-palette-4 { background: #bbf7d0; border-color: #15803d; color: #14532d; }
.fgi-box.fgi-palette-5 { background: #fef9c3; border-color: #a16207; color: #713f12; }
.fgi-box.fgi-palette-6 { background: #fecaca; border-color: #b91c1c; color: #7f1d1d; }
.fgi-box.fgi-palette-7 { background: #fed7aa; border-color: #c2410c; color: #7c2d12; }
.fgi-box.fgi-palette-8 { background: #e5e7eb; border-color: #374151; color: #111827; }
.fgi-box.fgi-palette-9 { background: #111; border-color: #fff; color: #fff; }
.fgi-box.fgi-font-2 { font-size: 16px; } .fgi-box.fgi-font-3 { font-size: 18px; } .fgi-box.fgi-font-4 { font-size: 20px; }
.fgi-box.fgi-font-5 { font-size: 24px; } .fgi-box.fgi-font-6 { font-size: 28px; } .fgi-box.fgi-font-7 { font-size: 34px; }
.fgi-box.fgi-font-8 { font-size: 42px; } .fgi-box.fgi-font-9 { font-size: 56px; }
.fgi-text { position: absolute; font-size: 14px; color: #333; white-space: pre-wrap; pointer-events: none; }
.fgi-text.fgi-palette-2 { color: #1d4ed8; } .fgi-text.fgi-palette-3 { color: #6d28d9; } .fgi-text.fgi-palette-4 { color: #15803d; }
.fgi-text.fgi-palette-5 { color: #a16207; } .fgi-text.fgi-palette-6 { color: #b91c1c; } .fgi-text.fgi-palette-7 { color: #c2410c; }
.fgi-text.fgi-palette-8 { color: #374151; } .fgi-text.fgi-palette-9 { color: #000; }
.fgi-text.fgi-font-2 { font-size: 16px; } .fgi-text.fgi-font-3 { font-size: 18px; } .fgi-text.fgi-font-4 { font-size: 20px; }
.fgi-text.fgi-font-5 { font-size: 24px; } .fgi-text.fgi-font-6 { font-size: 28px; } .fgi-text.fgi-font-7 { font-size: 34px; }
.fgi-text.fgi-font-8 { font-size: 42px; } .fgi-text.fgi-font-9 { font-size: 56px; }
.fgi-edge-label {
  position: absolute; transform: translate(-50%, -50%); pointer-events: none;
  max-width: 220px; padding: 1px 5px; border-radius: 4px;
  background: rgba(255,255,255,.92); color: #444;
  font-size: 12px; line-height: 1.25; text-align: center;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.fgi-image { position: absolute; pointer-events: none; }
.fgi-image img { width: 100%; height: 100%; object-fit: contain; display: block; }
.fgi-edge-line, .fgi-line-line { stroke: #333; stroke-width: 2; fill: none; }
.fgi-stroke-line { stroke: #333; stroke-width: 3; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.fgi-palette-2 .fgi-edge-line, .fgi-palette-2 .fgi-line-line, .fgi-palette-2 .fgi-stroke-line { stroke: #1d4ed8; }
.fgi-palette-3 .fgi-edge-line, .fgi-palette-3 .fgi-line-line, .fgi-palette-3 .fgi-stroke-line { stroke: #6d28d9; }
.fgi-palette-4 .fgi-edge-line, .fgi-palette-4 .fgi-line-line, .fgi-palette-4 .fgi-stroke-line { stroke: #15803d; }
.fgi-palette-5 .fgi-edge-line, .fgi-palette-5 .fgi-line-line, .fgi-palette-5 .fgi-stroke-line { stroke: #a16207; }
.fgi-palette-6 .fgi-edge-line, .fgi-palette-6 .fgi-line-line, .fgi-palette-6 .fgi-stroke-line { stroke: #b91c1c; }
.fgi-palette-7 .fgi-edge-line, .fgi-palette-7 .fgi-line-line, .fgi-palette-7 .fgi-stroke-line { stroke: #c2410c; }
.fgi-palette-8 .fgi-edge-line, .fgi-palette-8 .fgi-line-line, .fgi-palette-8 .fgi-stroke-line { stroke: #374151; }
.fgi-palette-9 .fgi-edge-line, .fgi-palette-9 .fgi-line-line, .fgi-palette-9 .fgi-stroke-line { stroke: #000; }
`;

const ensureStyle = (): void => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE_CSS;
  document.head.appendChild(style);
};

export interface FlowgoInlineOptions {
  // Initial map path ("/" for root). Defaults to "/".
  readonly path?: string;
  // Enable drag-to-pan. Defaults to true.
  readonly pan?: boolean;
  // Enable wheel-to-zoom. Defaults to true.
  readonly zoom?: boolean;
  // Enable clicking a has-submap box (and the breadcrumb bar) to
  // navigate between maps. Defaults to true.
  readonly drillIn?: boolean;
  // Prefix prepended to relative image `src` values (the .flowgo
  // format stores paths relative to the source file, which a
  // standalone embed has no filesystem access to). Absolute URLs
  // (http(s):// or data:) are left untouched.
  readonly mediaBaseUrl?: string;
}

export interface FlowgoInlineInstance {
  readonly path: string;
  goTo(path: string): void;
  destroy(): void;
}

const resolveImageSrc = (src: string, base: string | undefined): string => {
  if (!base || /^(https?:)?\/\/|^data:/.test(src)) return src;
  return base.replace(/\/$/, "") + "/" + src.replace(/^\//, "");
};

const emptyMap = (path: string): ConcreteMap => ({ path, boxes: [], edges: [], texts: [], lines: [], strokes: [], images: [] });

// Render parsed .flowgo `flowgoText` into `container`, replacing its
// contents. Returns a handle for programmatic navigation + teardown.
export const renderFlowgo = (
  container: HTMLElement,
  flowgoText: string,
  opts: FlowgoInlineOptions = {},
): FlowgoInlineInstance => {
  ensureStyle();

  const graph: ConcreteGraph = parseFlowgo(flowgoText);
  const panEnabled = opts.pan ?? true;
  const zoomEnabled = opts.zoom ?? true;
  const drillInEnabled = opts.drillIn ?? true;
  const mediaBaseUrl = opts.mediaBaseUrl;

  let path = opts.path ?? "/";
  let tx = 0;
  let ty = 0;
  let scale = 1;

  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "fgi-root";

  const crumbs = document.createElement("div");
  crumbs.className = "fgi-crumbs";

  const viewport = document.createElement("div");
  viewport.className = "fgi-viewport";

  const world = document.createElement("div");
  world.className = "fgi-world";

  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("class", "fgi-svg");
  const strokeLayer = document.createElementNS(SVG_NS, "g");
  const lineLayer = document.createElementNS(SVG_NS, "g");
  const edgeLayer = document.createElementNS(SVG_NS, "g");
  svg.append(strokeLayer, lineLayer, edgeLayer);

  const layer = document.createElement("div");
  layer.className = "fgi-layer";

  world.append(svg, layer);
  viewport.appendChild(world);
  root.appendChild(viewport);
  if (drillInEnabled) root.appendChild(crumbs);
  container.appendChild(root);

  const applyTransform = (): void => {
    world.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const findMap = (p: string): ConcreteMap => graph.maps?.find((m) => m.path === p) ?? emptyMap(p);

  const renderCrumbs = (): void => {
    if (!drillInEnabled) return;
    crumbs.innerHTML = "";
    const segs = path === "/" ? [] : path.split("/").filter(Boolean);
    const mk = (label: string, target: string, current: boolean): void => {
      if (current) {
        const span = document.createElement("span");
        span.className = "fgi-crumb-cur";
        span.textContent = label;
        crumbs.appendChild(span);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.addEventListener("click", () => instance.goTo(target));
        crumbs.appendChild(btn);
        const sep = document.createElement("span");
        sep.className = "fgi-crumb-sep";
        sep.textContent = "/";
        crumbs.appendChild(sep);
      }
    };
    mk("/", "/", segs.length === 0);
    let acc = "";
    segs.forEach((id, i) => {
      acc += "/" + id;
      mk(id, acc, i === segs.length - 1);
    });
  };

  const renderMap = (): void => {
    layer.innerHTML = "";
    strokeLayer.innerHTML = "";
    lineLayer.innerHTML = "";
    edgeLayer.innerHTML = "";

    const map = findMap(path);
    const boxEls = new Map<string, HTMLElement>();

    for (const b of map.boxes ?? []) {
      const el = document.createElement("div");
      const palette = resolvePalette(b.palette);
      const font = resolveFont(b.font);
      const submap = drillInEnabled && hasSubmapContent(graph, path, b.id);
      el.className =
        "fgi-box" +
        (b.shape === 1 ? " fgi-hex" : b.shape === 2 ? " fgi-circle" : b.shape === 3 ? " fgi-tri" : "") +
        (submap ? " fgi-has-submap" : "") +
        (palette !== 1 ? " fgi-palette-" + palette : "") +
        (font !== 1 ? " fgi-font-" + font : "");
      el.style.left = b.x + "px";
      el.style.top = b.y + "px";
      const fixed = fixedShapeSize(b.shape);
      if (fixed) {
        el.style.width = fixed.w + "px";
        el.style.height = fixed.h + "px";
        el.classList.add("fgi-sized");
      } else if (b.w && b.h) {
        el.style.width = b.w + "px";
        el.style.height = b.h + "px";
        el.classList.add("fgi-sized");
      }
      el.textContent = b.label;
      if (submap) {
        el.title = "Click to open submap";
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          instance.goTo(submapPathFor(path, b.id));
        });
      }
      layer.appendChild(el);
      boxEls.set(b.id, el);
    }

    for (const t of map.texts ?? []) {
      const el = document.createElement("div");
      const palette = resolvePalette(t.palette);
      const font = resolveFont(t.font);
      el.className =
        "fgi-text" +
        (palette !== 1 ? " fgi-palette-" + palette : "") +
        (font !== 1 ? " fgi-font-" + font : "");
      el.style.left = t.x + "px";
      el.style.top = t.y + "px";
      el.textContent = t.label;
      layer.appendChild(el);
    }

    for (const img of map.images ?? []) {
      const el = document.createElement("div");
      el.className = "fgi-image";
      el.style.left = img.x + "px";
      el.style.top = img.y + "px";
      el.style.width = img.width + "px";
      el.style.height = img.height + "px";
      const im = document.createElement("img");
      im.src = resolveImageSrc(img.src, mediaBaseUrl);
      im.alt = "";
      el.appendChild(im);
      layer.appendChild(el);
    }

    for (const s of map.strokes ?? []) {
      if (!s.points || s.points.length < 2) continue;
      const pal = resolvePalette(s.palette);
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "fgi-stroke-group" + (pal !== 1 ? " fgi-palette-" + pal : ""));
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("class", "fgi-stroke-line");
      p.setAttribute("d", strokePathD(s.points));
      g.appendChild(p);
      strokeLayer.appendChild(g);
    }

    for (const l of map.lines ?? []) {
      const pal = resolvePalette(l.palette);
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "fgi-line-group" + (pal !== 1 ? " fgi-palette-" + pal : ""));
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("class", "fgi-line-line");
      p.setAttribute("d", linePathD(l));
      g.appendChild(p);
      lineLayer.appendChild(g);
    }

    // Edges need box layout (offsetWidth/offsetHeight), so they're
    // resolved after every box element is in the DOM.
    for (const e of map.edges ?? []) {
      const a = (map.boxes ?? []).find((b) => b.id === e.from);
      const b = (map.boxes ?? []).find((b) => b.id === e.to);
      const ea = a && boxEls.get(a.id);
      const eb = b && boxEls.get(b.id);
      if (!a || !b || !ea || !eb) continue;
      const boxA = { x: a.x, y: a.y, width: ea.offsetWidth, height: ea.offsetHeight };
      const boxB = { x: b.x, y: b.y, width: eb.offsetWidth, height: eb.offsetHeight };
      const bcx = boxB.x + boxB.width / 2;
      const bcy = boxB.y + boxB.height / 2;
      const acx = boxA.x + boxA.width / 2;
      const acy = boxA.y + boxA.height / 2;
      const [ax, ay] = rectAnchor(boxA, e.fromHandle, [bcx, bcy], a.shape);
      const [bx, by] = rectAnchor(boxB, e.toHandle, [acx, acy], b.shape);
      const pal = resolvePalette(e.palette);
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "fgi-edge-group" + (pal !== 1 ? " fgi-palette-" + pal : ""));
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "fgi-edge-line");
      line.setAttribute("x1", String(ax));
      line.setAttribute("y1", String(ay));
      line.setAttribute("x2", String(bx));
      line.setAttribute("y2", String(by));
      g.appendChild(line);
      edgeLayer.appendChild(g);

      // Midpoint label (brain#266). Read-only here, so it could have
      // been an SVG <text> — it's an HTML div for the same reason the
      // editor's is: translate(-50%,-50%) centres it on the midpoint
      // without anything measuring the text.
      const label = e.label ?? "";
      if (label !== "") {
        const el = document.createElement("div");
        el.className = "fgi-edge-label";
        el.style.left = (ax + bx) / 2 + "px";
        el.style.top = (ay + by) / 2 + "px";
        el.textContent = label;
        layer.appendChild(el);
      }
    }

    renderCrumbs();
  };

  // --- pan ---
  if (panEnabled) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTx = 0;
    let startTy = 0;
    viewport.addEventListener("pointerdown", (ev) => {
      if ((ev.target as HTMLElement).closest(".fgi-box, .fgi-has-submap")) return;
      dragging = true;
      viewport.classList.add("fgi-panning");
      viewport.setPointerCapture(ev.pointerId);
      startX = ev.clientX;
      startY = ev.clientY;
      startTx = tx;
      startTy = ty;
    });
    viewport.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      tx = startTx + (ev.clientX - startX);
      ty = startTy + (ev.clientY - startY);
      applyTransform();
    });
    const endDrag = (): void => {
      dragging = false;
      viewport.classList.remove("fgi-panning");
    };
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
  }

  // --- zoom ---
  if (zoomEnabled) {
    viewport.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cx = ev.clientX - rect.left;
        const cy = ev.clientY - rect.top;
        const worldX = (cx - tx) / scale;
        const worldY = (cy - ty) / scale;
        const factor = Math.exp(-ev.deltaY * 0.001);
        const next = Math.min(3, Math.max(0.2, scale * factor));
        tx = cx - worldX * next;
        ty = cy - worldY * next;
        scale = next;
        applyTransform();
      },
      { passive: false },
    );
  }

  const instance: FlowgoInlineInstance = {
    get path() {
      return path;
    },
    goTo(next: string) {
      path = next;
      renderMap();
    },
    destroy() {
      container.innerHTML = "";
    },
  };

  applyTransform();
  renderMap();
  return instance;
};

// linePathD mirrors editor/render.ts's line-path builder (straight /
// bezier / orthogonal styles); kept local since it's the one bit of
// render.ts's rendering logic that isn't already a pure graph helper.

interface LineLike {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly mids?: ReadonlyArray<readonly [number, number]> | undefined;
  readonly style?: number | undefined;
}

const linePathD = (l: LineLike): string => {
  const mids = l.mids ?? [];
  const points: Array<readonly [number, number]> = [[l.x1, l.y1], ...mids, [l.x2, l.y2]];
  const style = l.style ?? 1;

  if (style === 2 && mids.length > 0) {
    let d = `M ${l.x1} ${l.y1}`;
    for (let i = 0; i < mids.length - 1; i++) {
      const [cx, cy] = mids[i]!;
      const [nx, ny] = mids[i + 1]!;
      d += ` Q ${cx} ${cy} ${(cx + nx) / 2} ${(cy + ny) / 2}`;
    }
    const last = mids[mids.length - 1]!;
    d += ` Q ${last[0]} ${last[1]} ${l.x2} ${l.y2}`;
    return d;
  }
  if (style === 3) {
    let d = `M ${points[0]![0]} ${points[0]![1]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      d += Math.abs(bx - ax) >= Math.abs(by - ay) ? ` L ${bx} ${ay} L ${bx} ${by}` : ` L ${ax} ${by} L ${bx} ${by}`;
    }
    return d;
  }
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]![0]} ${points[i]![1]}`;
  return d;
};
