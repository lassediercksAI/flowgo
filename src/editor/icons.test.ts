// @vitest-environment jsdom
//
// The icon set is vendored path data injected via innerHTML — a typo
// in one of those strings fails silently in the browser (the SVG just
// doesn't draw). So the pin here is structural: every name yields a
// well-formed SVG whose children parse into known SVG drawing elements
// in the SVG namespace, wrapped with the house attributes (currentColor
// stroke, 24x24 viewBox, aria-hidden).

import { describe, expect, it } from "vitest";
import { icon, type IconName } from "./icons.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// The full IconName union, checked for exhaustiveness at compile time:
// adding an icon without extending this list fails `tsc --noEmit`.
const ALL_ICONS = [
  "arrow-up",
  "brush",
  "circle-help",
  "hexagon",
  "menu",
  "minus",
  "mouse-pointer",
  "pencil",
  "plus",
  "settings",
  "slash",
  "type",
  "x",
] as const satisfies readonly IconName[];
type Uncovered = Exclude<IconName, (typeof ALL_ICONS)[number]>;
// If this line errors, ALL_ICONS is missing a name from the union.
const _exhaustive: Uncovered[] = [];
void _exhaustive;

describe("icon() wrapper attributes", () => {
  it("builds a real SVG element in the SVG namespace", () => {
    const el = icon("plus");
    expect(el).toBeInstanceOf(SVGSVGElement);
    expect(el.namespaceURI).toBe(SVG_NS);
    expect(el.tagName.toLowerCase()).toBe("svg");
  });

  it("is aria-hidden — decorative, the accessible name lives on the button", () => {
    for (const name of ALL_ICONS) {
      expect(icon(name).getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("inherits colour from the surrounding text", () => {
    const el = icon("menu");
    expect(el.getAttribute("stroke")).toBe("currentColor");
    expect(el.getAttribute("fill")).toBe("none");
  });

  it("uses the Lucide stroke style", () => {
    const el = icon("brush");
    expect(el.getAttribute("stroke-width")).toBe("2");
    expect(el.getAttribute("stroke-linecap")).toBe("round");
    expect(el.getAttribute("stroke-linejoin")).toBe("round");
  });

  it("defaults to a 20px square", () => {
    const el = icon("x");
    expect(el.getAttribute("width")).toBe("20");
    expect(el.getAttribute("height")).toBe("20");
  });

  it("renders at a requested size while the drawing keeps the 24x24 viewBox", () => {
    const el = icon("settings", 32);
    expect(el.getAttribute("width")).toBe("32");
    expect(el.getAttribute("height")).toBe("32");
    // The viewBox is the coordinate system of the vendored path data —
    // it must NOT scale with the rendered size.
    expect(el.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon("settings").getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("returns a fresh element per call so callers can mount it twice", () => {
    const a = icon("plus");
    const b = icon("plus");
    expect(a).not.toBe(b);
    expect(b.isEqualNode(a)).toBe(true);
  });
});

describe("vendored path data parses for every icon", () => {
  for (const name of ALL_ICONS) {
    it(`${name} yields known SVG drawing elements`, () => {
      const el = icon(name);
      // A typo'd string parses to zero children (or junk elements) —
      // both must fail loudly here rather than render an empty button.
      expect(el.children.length).toBeGreaterThan(0);
      for (const child of Array.from(el.children)) {
        expect(child.namespaceURI).toBe(SVG_NS);
        // The vendored set only uses these two element kinds; anything
        // else means a copy/paste picked up markup we don't style.
        expect(["path", "circle"]).toContain(child.tagName.toLowerCase());
      }
    });
  }

  it("every path carries a non-empty d attribute", () => {
    for (const name of ALL_ICONS) {
      for (const p of Array.from(icon(name).querySelectorAll("path"))) {
        expect(p.getAttribute("d")).toBeTruthy();
      }
    }
  });

  it("circles carry the geometry Lucide draws with", () => {
    // Both circle users: circle-help's outline and settings' hub.
    const help = icon("circle-help").querySelector("circle")!;
    expect(help.getAttribute("r")).toBe("10");
    const hub = icon("settings").querySelector("circle")!;
    expect(hub.getAttribute("r")).toBe("3");
  });
});
