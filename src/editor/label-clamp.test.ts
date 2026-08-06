// @vitest-environment jsdom
//
// brain#258. The bar for the batched label clamp is that it produces
// EXACTLY what the old per-element version produced — same truncation
// at the same widths for rectangles, hexagons, circles and triangles
// — while touching the DOM in the read-all-then-write-all order that
// costs one layout flush instead of one per box.
//
// So the oracle here is the old implementation, copied verbatim from
// the commit this replaces. Every clamp value the batch produces is
// compared against it.
//
// jsdom has no layout engine, so this file supplies one: a stub
// getComputedStyle that reproduces the real stylesheet's metrics from
// the class list (`line-height: 1.2`, `padding: 0.55em 0.85em`, the
// `.font-2..9` ladder, the per-shape padding overrides), and a
// clientHeight defined per element. That is enough to exercise the
// arithmetic, the memoisation key and the read/write ordering — the
// three things that could make the output diverge. The real-browser
// half of the proof (identical `--label-clamp`, identical painted
// line-box counts and label rects across all four shapes × 9 font
// sizes × 6 label lengths) lives in the PR description.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushLabelClamps,
  queueLabelClamp,
  resetLabelClampMetrics,
  shapeLabelClampFrac,
  updateSizedLabelClamp,
} from "./label-clamp.ts";

// ── the stylesheet, as jsdom would need to have implemented it ──
const FONT_PX: Record<number, number> = {
  1: 16, 2: 16, 3: 18, 4: 20, 5: 24, 6: 28, 7: 34, 8: 42, 9: 56,
};

const fontOf = (cls: string): number => {
  const m = /\bfont-(\d)\b/.exec(cls);
  return FONT_PX[m ? Number(m[1]) : 1]!;
};

// Mirrors index.html: `.box { line-height: 1.2; padding: 0.55em 0.85em }`,
// `.box.circle { padding: 0 }`, `.box.tri { padding: 64px 0 0 }`.
const styleFor = (el: Element): { lineHeight: string; paddingTop: string; paddingBottom: string } => {
  const box = el.classList.contains("box-label")
    ? (el.parentElement as HTMLElement)
    : (el as HTMLElement);
  const cls = box.className;
  const fs = fontOf(cls);
  let padTop = 0.55 * fs;
  let padBottom = 0.55 * fs;
  if (cls.includes("circle")) { padTop = 0; padBottom = 0; }
  else if (cls.includes("tri")) { padTop = 64; padBottom = 0; }
  return {
    lineHeight: 1.2 * fs + "px",
    paddingTop: padTop + "px",
    paddingBottom: padBottom + "px",
  };
};

let styleReads = 0;

beforeEach(() => {
  document.body.innerHTML = "";
  resetLabelClampMetrics();
  flushLabelClamps(); // drain anything a previous test left queued
  styleReads = 0;
  vi.stubGlobal("getComputedStyle", (el: Element) => {
    styleReads++;
    return styleFor(el) as unknown as CSSStyleDeclaration;
  });
});

interface Spec {
  cls: string;
  h: number;
  /** null = sized rectangle, otherwise the shape's usable fraction. */
  frac: number | null;
}

const makeBox = (spec: Spec): HTMLElement => {
  const el = document.createElement("div");
  el.className = spec.cls;
  const label = document.createElement("span");
  label.className = "box-label";
  label.textContent = "some label text that is long enough to wrap a few times";
  el.appendChild(label);
  document.body.appendChild(el);
  // jsdom always reports 0; the frame height is the whole input here.
  Object.defineProperty(el, "clientHeight", { value: spec.h, configurable: true });
  return el;
};

// ── ORACLE: label-clamp.ts as it was before the batching change ──
const oracleShape = (el: HTMLElement, frac: number): string | null => {
  const label = el.querySelector<HTMLElement>(".box-label");
  if (!label) return null;
  const lineH = parseFloat(getComputedStyle(label).lineHeight);
  if (!Number.isFinite(lineH) || lineH <= 0) return null;
  const avail = el.clientHeight * frac;
  return String(Math.max(1, Math.floor(avail / lineH)));
};

const oracleSized = (el: HTMLElement): string | null => {
  const label = el.querySelector<HTMLElement>(".box-label");
  if (!label) return null;
  const boxCS = getComputedStyle(el);
  const padY = parseFloat(boxCS.paddingTop) + parseFloat(boxCS.paddingBottom);
  const lineH = parseFloat(getComputedStyle(label).lineHeight);
  if (!Number.isFinite(lineH) || lineH <= 0) return null;
  const avail = el.clientHeight - padY;
  return String(Math.max(1, Math.floor(avail / lineH)));
};

const oracle = (el: HTMLElement, frac: number | null): string | null =>
  frac === null ? oracleSized(el) : oracleShape(el, frac);

// The four fixed-frame paths at their real frame sizes: hexagon and
// triangle 240×208, circle 208×208 (see fixedShapeSize / the CSS),
// resized rectangles at a spread of user-chosen heights. Crossed with
// the whole font ladder, because the line budget scales with it.
const specs = (): Spec[] => {
  const out: Spec[] = [];
  for (let font = 1; font <= 9; font++) {
    const f = font === 1 ? "" : " font-" + font;
    out.push({ cls: "box hex" + f, h: 208, frac: 0.64 });
    out.push({ cls: "box circle" + f, h: 208, frac: 0.62 });
    out.push({ cls: "box tri" + f, h: 208, frac: 0.4 });
    for (const h of [36, 64, 96, 120, 140, 72, 300]) {
      out.push({ cls: "box sized" + f, h, frac: null });
    }
  }
  return out;
};

describe("shapeLabelClampFrac", () => {
  it("maps each special shape to its usable-height fraction", () => {
    expect(shapeLabelClampFrac(1)).toBe(0.64);
    expect(shapeLabelClampFrac(2)).toBe(0.62);
    expect(shapeLabelClampFrac(3)).toBe(0.4);
    // Rectangles (auto-sized) have no fixed frame to clamp against.
    expect(shapeLabelClampFrac(0)).toBeNull();
    expect(shapeLabelClampFrac(undefined)).toBeNull();
    expect(shapeLabelClampFrac(4)).toBeNull();
  });
});

describe("batched label clamp (#258)", () => {
  it("produces byte-identical clamps to the per-element version", () => {
    const list = specs();
    // Oracle first, on its own elements, so the batch under test can't
    // be influenced by (or accidentally read) the oracle's writes.
    const want = list.map((s) => {
      const el = makeBox(s);
      const v = oracle(el, s.frac);
      el.remove();
      return v;
    });

    resetLabelClampMetrics();
    const els = list.map(makeBox);
    els.forEach((el, i) => queueLabelClamp(el, list[i]!.frac));
    flushLabelClamps();

    els.forEach((el, i) => {
      expect(
        el.style.getPropertyValue("--label-clamp"),
        `${list[i]!.cls} h=${list[i]!.h}`,
      ).toBe(want[i]);
    });
    // Guard against the whole thing being vacuously "1" everywhere.
    expect(new Set(want).size).toBeGreaterThan(4);
  });

  it("issues every read before any write (one flush, not N)", () => {
    const list = specs();
    const els = list.map(makeBox);
    const trace: string[] = [];
    const realGCS = globalThis.getComputedStyle;
    vi.stubGlobal("getComputedStyle", (el: Element) => {
      trace.push("read");
      return realGCS(el);
    });
    for (const el of els) {
      const d = Object.getOwnPropertyDescriptor(el, "clientHeight")!;
      Object.defineProperty(el, "clientHeight", {
        configurable: true,
        get: () => {
          trace.push("read");
          return d.value as number;
        },
      });
      const orig = el.style.setProperty.bind(el.style);
      el.style.setProperty = (...args: Parameters<typeof orig>) => {
        trace.push("write");
        return orig(...args);
      };
    }

    els.forEach((el, i) => queueLabelClamp(el, list[i]!.frac));
    // Queuing alone must touch nothing at all.
    expect(trace).toEqual([]);
    flushLabelClamps();

    expect(trace.length).toBeGreaterThan(0);
    // The invariant: the trace is a block of reads followed by a block
    // of writes. A single read after the first write is a per-element
    // flush and fails here.
    const firstWrite = trace.indexOf("write");
    expect(firstWrite, "something must be written").toBeGreaterThan(-1);
    expect(
      trace.slice(firstWrite).every((t) => t === "write"),
      "no read may follow a write within a flush",
    ).toBe(true);
    expect(trace.slice(0, firstWrite).every((t) => t === "read")).toBe(true);
  });

  it("memoises style reads per class list, not per element", () => {
    // 500 boxes over 3 distinct class lists.
    const kinds: Spec[] = [
      { cls: "box hex", h: 208, frac: 0.64 },
      { cls: "box sized font-5", h: 120, frac: null },
      { cls: "box tri font-9", h: 208, frac: 0.4 },
    ];
    const els: HTMLElement[] = [];
    for (let i = 0; i < 500; i++) {
      const s = kinds[i % kinds.length]!;
      const el = makeBox(s);
      els.push(el);
      queueLabelClamp(el, s.frac);
    }
    styleReads = 0;
    flushLabelClamps();
    // 3 class lists × (label line-height + box padding) = 6 reads for
    // 500 boxes. Per element it would be 1,000.
    expect(styleReads).toBe(6);
    // ...and every box still got the right answer.
    for (let i = 0; i < els.length; i++) {
      const s = kinds[i % kinds.length]!;
      expect(els[i]!.style.getPropertyValue("--label-clamp"))
        .toBe(oracle(els[i]!, s.frac));
    }
  });

  it("distinguishes class lists that compute different metrics", () => {
    const a = makeBox({ cls: "box sized", h: 120, frac: null });
    const b = makeBox({ cls: "box sized font-9", h: 120, frac: null });
    queueLabelClamp(a, null);
    queueLabelClamp(b, null);
    flushLabelClamps();
    // Same 120px frame, 16px vs 56px font — different padding AND
    // different line-height: (120 − 17.6)/19.2 = 5 lines against
    // (120 − 61.6)/67.2 = 0 lines, floored to the one-line minimum.
    // One cache entry serving both would give the same answer twice.
    expect(a.style.getPropertyValue("--label-clamp")).toBe("5");
    expect(b.style.getPropertyValue("--label-clamp")).toBe("1");
  });

  it("flushes on a microtask when no caller flushes explicitly", async () => {
    const el = makeBox({ cls: "box hex", h: 208, frac: 0.64 });
    queueLabelClamp(el, 0.64);
    expect(el.style.getPropertyValue("--label-clamp")).toBe("");
    // Microtasks run before the browser paints, so the safety net
    // cannot produce a visible frame of unclamped text.
    await Promise.resolve();
    expect(el.style.getPropertyValue("--label-clamp")).toBe("6");
  });

  it("skips elements detached before the flush", () => {
    const gone = makeBox({ cls: "box hex", h: 208, frac: 0.64 });
    const live = makeBox({ cls: "box hex", h: 208, frac: 0.64 });
    queueLabelClamp(gone, 0.64);
    queueLabelClamp(live, 0.64);
    gone.remove();
    flushLabelClamps();
    expect(gone.style.getPropertyValue("--label-clamp")).toBe("");
    expect(live.style.getPropertyValue("--label-clamp")).toBe("6");
  });

  it("tolerates a box with no label element", () => {
    const el = document.createElement("div");
    el.className = "box sized";
    document.body.appendChild(el);
    queueLabelClamp(el, null);
    expect(() => flushLabelClamps()).not.toThrow();
    expect(el.style.getPropertyValue("--label-clamp")).toBe("");
  });

  it("writes nothing when line-height is unavailable", () => {
    // What jsdom (and a not-yet-styled document) actually reports.
    vi.stubGlobal("getComputedStyle", () => ({
      lineHeight: "normal",
      paddingTop: "0px",
      paddingBottom: "0px",
    }) as unknown as CSSStyleDeclaration);
    const el = makeBox({ cls: "box sized", h: 120, frac: null });
    queueLabelClamp(el, null);
    flushLabelClamps();
    expect(el.style.getPropertyValue("--label-clamp")).toBe("");
  });

  it("never budgets fewer than one line, however small the frame", () => {
    const el = makeBox({ cls: "box sized font-9", h: 36, frac: null });
    queueLabelClamp(el, null);
    flushLabelClamps();
    expect(el.style.getPropertyValue("--label-clamp")).toBe("1");
  });

  it("updateSizedLabelClamp still applies immediately (resize drag)", () => {
    // movers.ts calls this once per drag tick after writing the new
    // width/height; the result has to be on screen this frame.
    const el = makeBox({ cls: "box sized", h: 120, frac: null });
    updateSizedLabelClamp(el);
    expect(el.style.getPropertyValue("--label-clamp")).toBe(oracleSized(el));
    // A later resize re-budgets against the new frame.
    Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
    updateSizedLabelClamp(el);
    expect(el.style.getPropertyValue("--label-clamp")).toBe(oracleSized(el));
  });

  it("an immediate clamp does not strand a pending batch", () => {
    const queued = makeBox({ cls: "box tri", h: 208, frac: 0.4 });
    queueLabelClamp(queued, 0.4);
    const dragged = makeBox({ cls: "box sized", h: 120, frac: null });
    updateSizedLabelClamp(dragged);
    // updateSizedLabelClamp flushes the whole queue, so the box that
    // was already waiting gets its clamp too rather than being
    // dropped on the floor.
    expect(queued.style.getPropertyValue("--label-clamp")).toBe(oracleShape(queued, 0.4));
    expect(dragged.style.getPropertyValue("--label-clamp")).toBe(oracleSized(dragged));
  });
});
