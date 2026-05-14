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
    expect(out).toBe("box b1 hi 10 20\n");
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
      "map /\nbox b1 a 0 0\n\nmap /b1\nbox c1 child 0 0\n",
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
    expect(out).toBe("map /b1\nbox x kept 0 0\n");
  });

  it("emits sides/palette/font as positional tokens with default placeholders", () => {
    expect(
      serializeGraph({
        maps: [
          {
            path: "/",
            boxes: [
              { id: "a", label: "rect", x: 0, y: 0 },
              { id: "b", label: "tri", x: 0, y: 0, sides: 3 },
              { id: "c", label: "rect-coloured", x: 0, y: 0, palette: 5 },
              {
                id: "d",
                label: "tri-coloured-big",
                x: 0,
                y: 0,
                sides: 3,
                palette: 5,
                font: 7,
              },
              { id: "e", label: "rect-big", x: 0, y: 0, font: 6 },
            ],
          },
        ],
      }),
    ).toBe(
      [
        "box a rect 0 0",
        "box b tri 0 0 3",
        "box c rect-coloured 0 0 4 5",
        "box d tri-coloured-big 0 0 3 5 7",
        "box e rect-big 0 0 4 1 6",
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
});
