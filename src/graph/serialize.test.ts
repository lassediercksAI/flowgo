import { describe, expect, it } from "vitest";
import { flowgoNum, flowgoQuote, serializeGraph } from "./serialize";

describe("flowgoQuote", () => {
  it("returns plain text when no whitespace / quote / backslash present", () => {
    expect(flowgoQuote("hello")).toBe("hello");
    expect(flowgoQuote("a/b.c")).toBe("a/b.c");
    expect(flowgoQuote("?!&%")).toBe("?!&%");
  });

  it("wraps the empty string in quotes (special-cased to avoid token loss)", () => {
    expect(flowgoQuote("")).toBe('""');
  });

  it("wraps and escapes when whitespace appears", () => {
    expect(flowgoQuote("a b")).toBe('"a b"');
    expect(flowgoQuote("a\tb")).toBe('"a\tb"');
  });

  it("escapes backslashes and double quotes", () => {
    expect(flowgoQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(flowgoQuote("a\\b")).toBe('"a\\\\b"');
  });

  it("encodes embedded newlines as the `\\n` escape", () => {
    // The .flowgo format is line-based, so a literal newline in a
    // quoted value would split the directive across input lines.
    expect(flowgoQuote("first\nsecond")).toBe('"first\\nsecond"');
  });
});

describe("flowgoNum", () => {
  it("renders integers without trailing dot", () => {
    expect(flowgoNum(0)).toBe("0");
    expect(flowgoNum(42)).toBe("42");
    expect(flowgoNum(-3)).toBe("-3");
  });

  it("renders floats verbatim", () => {
    expect(flowgoNum(1.5)).toBe("1.5");
  });
});

describe("serializeGraph", () => {
  it("emits a minimal box on root map without the `map /` header", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          boxes: [{ id: "b1", label: "hi", x: 10, y: 20 }],
        },
      ],
    });
    expect(out).toBe("node b1 hi 10 20\n");
  });

  it("emits an image directive (id src x y width height)", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          images: [
            {
              id: "img1",
              src: "flowgo-media/abc123.png",
              x: 10,
              y: 20,
              width: 300,
              height: 200,
            },
          ],
        },
      ],
    });
    expect(out).toBe("image img1 flowgo-media/abc123.png 10 20 300 200\n");
  });

  it("separates an image block from a preceding box block with a blank line", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          boxes: [{ id: "b1", label: "hi", x: 0, y: 0 }],
          images: [
            { id: "img1", src: "flowgo-media/x.png", x: 0, y: 0, width: 100, height: 80 },
          ],
        },
      ],
    });
    expect(out).toBe(
      ["node b1 hi 0 0", "", "image img1 flowgo-media/x.png 0 0 100 80", ""].join("\n"),
    );
  });

  it("emits a `map` header when there are multiple maps", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          boxes: [{ id: "b1", label: "a", x: 0, y: 0 }],
        },
        {
          path: "/b1",
          boxes: [{ id: "c1", label: "child", x: 0, y: 0 }],
        },
      ],
    });
    expect(out).toBe(
      "map /\nnode b1 a 0 0\n\nmap /b1\nnode c1 child 0 0\n",
    );
  });

  it("drops empty maps", () => {
    const out = serializeGraph({
      maps: [
        { path: "/" },
        {
          path: "/b1",
          boxes: [{ id: "x", label: "kept", x: 0, y: 0 }],
        },
      ],
    });
    expect(out).toBe("map /b1\nnode x kept 0 0\n");
  });

  it("emits palette/font as positional tokens with a vestigial sides placeholder", () => {
    // The "4" between coords and palette is a vestigial sides slot
    // kept so old binaries can still parse files written by 0.0.24+.
    expect(
      serializeGraph({
        maps: [
          {
            path: "/",
            boxes: [
              { id: "a", label: "plain", x: 0, y: 0 },
              { id: "b", label: "coloured", x: 0, y: 0, palette: 5 },
              { id: "c", label: "big", x: 0, y: 0, font: 6 },
              { id: "d", label: "coloured-big", x: 0, y: 0, palette: 5, font: 7 },
            ],
          },
        ],
      }),
    ).toBe(
      [
        "node a plain 0 0",
        "node b coloured 0 0 4 5",
        "node c big 0 0 4 1 6",
        "node d coloured-big 0 0 4 5 7",
        "",
      ].join("\n"),
    );
  });

  it("emits edge handles only when set", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          edges: [
            { from: "a", to: "b" },
            { from: "a", to: "b", fromHandle: "tl", toHandle: "br" },
          ],
        },
      ],
    });
    expect(out).toBe("edge a b\nedge a:tl b:br\n");
  });

  it("emits edge palette as an optional trailing token", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          edges: [
            { from: "a", to: "b" },
            { from: "a", to: "b", palette: 5 },
            { from: "a", to: "b", fromHandle: "tl", toHandle: "br", palette: 7 },
          ],
        },
      ],
    });
    expect(out).toBe("edge a b\nedge a b 5\nedge a:tl b:br 7\n");
  });

  it("emits version directive as the first line when set", () => {
    const out = serializeGraph({
      version: "0.0.23",
      maps: [
        {
          path: "/",
          boxes: [{ id: "a", label: "hi", x: 0, y: 0 }],
        },
      ],
    });
    expect(out.startsWith("version 0.0.23\n")).toBe(true);
  });

  it("omits version directive when version is unset or empty", () => {
    const out = serializeGraph({
      maps: [{ path: "/", boxes: [{ id: "a", label: "hi", x: 0, y: 0 }] }],
    });
    expect(out.startsWith("version")).toBe(false);
  });

  it("emits line palette as an optional trailing token", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          lines: [
            { id: "l1", x1: 0, y1: 0, x2: 10, y2: 10 },
            { id: "l2", x1: 0, y1: 0, x2: 10, y2: 10, palette: 4 },
          ],
        },
      ],
    });
    expect(out).toBe("line l1 0 0 10 10\nline l2 0 0 10 10 4\n");
  });

  it("emits `linestyle <id> <style>` directive after the line block", () => {
    // Styled lines emit a follow-up directive (mirrors the `anchor`
    // pattern) so older flowgo binaries that don't know styles still
    // parse the geometry cleanly. Default style (1 or unset) is silent.
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          lines: [
            { id: "a", x1: 0, y1: 0, x2: 10, y2: 10 },
            { id: "b", x1: 0, y1: 0, x2: 10, y2: 10, style: 2 },
            { id: "c", x1: 0, y1: 0, x2: 10, y2: 10, style: 3 },
            { id: "d", x1: 0, y1: 0, x2: 10, y2: 10, style: 1 },
          ],
        },
      ],
    });
    expect(out).toBe(
      [
        "line a 0 0 10 10",
        "line b 0 0 10 10",
        "line c 0 0 10 10",
        "line d 0 0 10 10",
        "linestyle b 2",
        "linestyle c 3",
        "",
      ].join("\n"),
    );
  });

  it("emits `nodeshape <id> <shape>` after the node block, before anchor", () => {
    // Shaped boxes emit a follow-up directive (mirrors linestyle) so
    // older flowgo binaries that don't know shapes still parse the box
    // geometry cleanly. Default shape (0 or unset) is silent. The
    // box → nodeshape → anchor order must match the Go serializer in
    // pkg/graph byte-for-byte.
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          boxes: [
            { id: "b1", label: "rect", x: 0, y: 0, anchor: true },
            { id: "b2", label: "hex", x: 10, y: 20, shape: 1 },
            { id: "b3", label: "plain", x: 30, y: 40, shape: 0 },
          ],
        },
      ],
    });
    expect(out).toBe(
      [
        "node b1 rect 0 0",
        "node b2 hex 10 20",
        "node b3 plain 30 40",
        "nodeshape b2 1",
        "anchor b1",
        "",
      ].join("\n"),
    );
  });

  it("emits line mid control points after the palette slot", () => {
    // When mids are present without a real palette we emit the "1"
    // sentinel so the coordinates land in stable positional slots;
    // the parser ignores palette=1. Multiple mids extend the line as
    // an even-length sequence after the palette token.
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          lines: [
            { id: "l1", x1: 0, y1: 0, x2: 10, y2: 10, mids: [[5, 8]] },
            { id: "l2", x1: 0, y1: 0, x2: 10, y2: 10, palette: 4, mids: [[5, 8]] },
            { id: "l3", x1: 0, y1: 0, x2: 10, y2: 10, mids: [[3, 4], [6, 7]] },
          ],
        },
      ],
    });
    expect(out).toBe(
      [
        "line l1 0 0 10 10 1 5 8",
        "line l2 0 0 10 10 4 5 8",
        "line l3 0 0 10 10 1 3 4 6 7",
        "",
      ].join("\n"),
    );
  });

  it("emits stroke points as comma pairs", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          strokes: [{ id: "s1", points: [[1, 2], [3, 4], [5, 6]] }],
        },
      ],
    });
    expect(out).toBe("stroke s1 1,2 3,4 5,6\n");
  });

  it("emits stroke palette as a token between id and first point", () => {
    // Disambiguation hinges on the palette token having no comma —
    // a regression that emitted `stroke s1 3,0 1,2 3,4` would parse as
    // four points and silently drop the colour. Asserting the literal
    // wire form pins that the token stays comma-free.
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          strokes: [
            { id: "s1", points: [[0, 0], [1, 1]], palette: 3 },
            { id: "s2", points: [[0, 0], [1, 1]], palette: 7 },
          ],
        },
      ],
    });
    expect(out).toBe("stroke s1 3 0,0 1,1\nstroke s2 7 0,0 1,1\n");
  });

  it("omits the palette token for default / out-of-range strokes", () => {
    // Mirrors the Go serializer: default palette (1 or 0 or undefined)
    // round-trips as the legacy `stroke <id> x,y …` form so files
    // written before colour support stay byte-equivalent.
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          strokes: [
            { id: "a", points: [[0, 0], [1, 1]] },
            { id: "b", points: [[0, 0], [1, 1]], palette: 0 },
            { id: "c", points: [[0, 0], [1, 1]], palette: 1 },
            { id: "d", points: [[0, 0], [1, 1]], palette: 99 },
          ],
        },
      ],
    });
    expect(out).toBe(
      "stroke a 0,0 1,1\nstroke b 0,0 1,1\nstroke c 0,0 1,1\nstroke d 0,0 1,1\n",
    );
  });

  it("drops a stroke with fewer than 2 points", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          strokes: [{ id: "s1", points: [[1, 2]] }],
        },
      ],
    });
    expect(out).toBe("");
  });

  it("emits text palette/font with default placeholder", () => {
    expect(
      serializeGraph({
        maps: [
          {
            path: "/",
            texts: [
              { id: "t1", label: "plain", x: 0, y: 0 },
              { id: "t2", label: "red", x: 0, y: 0, palette: 3 },
              { id: "t3", label: "big", x: 0, y: 0, font: 5 },
            ],
          },
        ],
      }),
    ).toBe(
      [
        "text t1 plain 0 0",
        "text t2 red 0 0 3",
        "text t3 big 0 0 1 5",
        "",
      ].join("\n"),
    );
  });

  it("emits nodesize after the node block for explicitly sized boxes", () => {
    // Mirrors pkg/graph: nodesize directives follow the box lines and
    // precede the anchor directive; auto-sized boxes emit nothing.
    expect(
      serializeGraph({
        maps: [
          {
            path: "/",
            boxes: [
              { id: "b1", label: "sized", x: 1, y: 2, w: 180, h: 90, anchor: true },
              { id: "b2", label: "auto", x: 3, y: 4 },
            ],
          },
        ],
      }),
    ).toBe(
      [
        "node b1 sized 1 2",
        "node b2 auto 3 4",
        "nodesize b1 180 90",
        "anchor b1",
        "",
      ].join("\n"),
    );
  });

  it("skips nodesize when either dimension is missing or non-positive", () => {
    expect(
      serializeGraph({
        maps: [
          {
            path: "/",
            boxes: [
              { id: "b1", label: "half", x: 0, y: 0, w: 100 },
              { id: "b2", label: "zero", x: 0, y: 0, w: 0, h: 50 },
            ],
          },
        ],
      }),
    ).toBe(["node b1 half 0 0", "node b2 zero 0 0", ""].join("\n"));
  });
});

describe("defaultshape document directive", () => {
  it("emits `defaultshape <n>` after version when set", () => {
    expect(
      serializeGraph({
        version: "1.2.3",
        defaultShape: 3,
        maps: [{ path: "/", boxes: [{ id: "b1", label: "x", x: 0, y: 0 }] }],
      }),
    ).toBe(["version 1.2.3", "defaultshape 3", "node b1 x 0 0", ""].join("\n"));
  });

  it("emits nothing when absent or zero", () => {
    const out = serializeGraph({
      defaultShape: 0,
      maps: [{ path: "/", boxes: [{ id: "b1", label: "x", x: 0, y: 0 }] }],
    });
    expect(out).not.toContain("defaultshape");
    expect(out).not.toContain("hexagons");
  });

  it("never emits the legacy hexagons directive", () => {
    const out = serializeGraph({
      defaultShape: 1,
      maps: [{ path: "/", boxes: [{ id: "b1", label: "x", x: 0, y: 0 }] }],
    });
    expect(out).toContain("defaultshape 1\n");
    expect(out).not.toContain("hexagons");
  });
});

describe("node directive migration", () => {
  // The canonical directives are node / nodesize / nodeshape; the
  // legacy box spellings are parse-only aliases in pkg/graph and must
  // never appear in serializer output (serializing a legacy-parsed
  // graph IS the migration).
  it("never emits the legacy box spellings", () => {
    const out = serializeGraph({
      maps: [
        {
          path: "/",
          boxes: [
            { id: "b1", label: "sized", x: 1, y: 2, w: 120, h: 60 },
            { id: "b2", label: "hex", x: 3, y: 4, shape: 1 },
          ],
        },
      ],
    });
    expect(out).toContain("node b1 ");
    expect(out).toContain("nodesize b1 120 60\n");
    expect(out).toContain("nodeshape b2 1\n");
    expect(out).not.toMatch(/^box /m);
    expect(out).not.toMatch(/^boxsize /m);
    expect(out).not.toMatch(/^boxshape /m);
  });
});
