import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FlowgoParseError, parseFlowgo } from "./parse";
import { serializeGraph, type ConcreteGraph } from "./serialize";

// parseFlowgo always populates maps/boxes/edges/etc as concrete arrays
// (never leaves them undefined), so tests can assert past the
// ConcreteGraph/ConcreteMap types' optionality with `!`.

describe("parseFlowgo", () => {
  it("parses a minimal single-box root map", () => {
    const g = parseFlowgo("node b1 hi 10 20\n");
    expect(g.maps).toEqual([
      { path: "/", boxes: [{ id: "b1", label: "hi", x: 10, y: 20 }], edges: [], texts: [], lines: [], strokes: [], images: [] },
    ]);
  });

  it("ignores blank lines and comments", () => {
    const g = parseFlowgo("# a comment\n\nnode b1 hi 0 0\n  \n");
    expect(g.maps![0]!.boxes!).toEqual([{ id: "b1", label: "hi", x: 0, y: 0 }]);
  });

  it("reads version and defaultshape directives", () => {
    const g = parseFlowgo("version 0.2.0\ndefaultshape 1\nnode b1 hi 0 0\n");
    expect(g.version).toBe("0.2.0");
    expect(g.defaultShape).toBe(1);
  });

  it("maps legacy `hexagons on` to defaultShape 1, `hexagons off` to a no-op", () => {
    expect(parseFlowgo("hexagons on\nnode b1 hi 0 0\n").defaultShape).toBe(1);
    expect(parseFlowgo("hexagons off\nnode b1 hi 0 0\n").defaultShape).toBeUndefined();
  });

  it("parses quoted labels with escapes", () => {
    const g = parseFlowgo('node b1 "say \\"hi\\"\\nline2" 0 0\n');
    expect(g.maps![0]!.boxes![0]!.label).toBe('say "hi"\nline2');
  });

  it("parses palette/font on node, discarding vestigial sides/rotation", () => {
    const g = parseFlowgo("node b1 hi 0 0 4 7 3 9\n");
    expect(g.maps![0]!.boxes![0]).toMatchObject({ palette: 7, font: 3 });
  });

  it("parses edges with handles and palette", () => {
    const g = parseFlowgo("node b1 a 0 0\nnode b2 b 1 1\nedge b1:t b2:bl 5\n");
    expect(g.maps![0]!.edges![0]).toEqual({
      from: "b1",
      fromHandle: "t",
      to: "b2",
      toHandle: "bl",
      palette: 5,
    });
  });

  // brain#266: slot 5 is the edge label, behind the palette. Palette 1
  // is the sentinel that holds the slot for an otherwise-unstyled
  // labelled edge and must not become a real palette.
  it("parses the edge label out of slot 5", () => {
    const g = parseFlowgo('node b1 a 0 0\nnode b2 b 1 1\nedge b1 b2 1 "depends on"\n');
    expect(g.maps![0]!.edges![0]).toEqual({
      from: "b1",
      to: "b2",
      label: "depends on",
    });
    const styled = parseFlowgo("node b1 a 0 0\nnode b2 b 1 1\nedge b1:t b2:bl 5 owns\n");
    expect(styled.maps![0]!.edges![0]).toEqual({
      from: "b1",
      fromHandle: "t",
      to: "b2",
      toHandle: "bl",
      palette: 5,
      label: "owns",
    });
  });

  it("reads a hand-written empty edge label token as no label", () => {
    const g = parseFlowgo('node b1 a 0 0\nnode b2 b 1 1\nedge b1 b2 1 ""\n');
    expect(g.maps![0]!.edges![0]).toEqual({ from: "b1", to: "b2" });
  });

  it("parses nodesize / nodeshape / anchor annotations onto an existing box", () => {
    const g = parseFlowgo("node b1 hi 0 0\nnodesize b1 100 50\nnodeshape b1 1\nanchor b1\n");
    expect(g.maps![0]!.boxes![0]).toMatchObject({ w: 100, h: 50, shape: 1, anchor: true });
  });

  it("accepts the legacy box/boxsize/boxshape spellings", () => {
    const g = parseFlowgo("box b1 hi 0 0\nboxsize b1 100 50\nboxshape b1 2\n");
    expect(g.maps![0]!.boxes![0]).toMatchObject({ w: 100, h: 50, shape: 2 });
  });

  it("parses lines with mids and linestyle", () => {
    const g = parseFlowgo("line l1 0 0 10 10 1 5 5\nlinestyle l1 3\n");
    expect(g.maps![0]!.lines![0]).toEqual({
      id: "l1",
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 10,
      mids: [[5, 5]],
      style: 3,
    });
  });

  it("parses strokes with and without a leading palette token", () => {
    const withPal = parseFlowgo("stroke s1 3 0,0 1,1\n");
    expect(withPal.maps![0]!.strokes![0]).toEqual({ id: "s1", points: [[0, 0], [1, 1]], palette: 3 });
    const noPal = parseFlowgo("stroke s2 0,0 1,1\n");
    expect(noPal.maps![0]!.strokes![0]).toEqual({ id: "s2", points: [[0, 0], [1, 1]] });
  });

  it("parses images", () => {
    const g = parseFlowgo('image i1 "media/x.png" 0 0 100 50\n');
    expect(g.maps![0]!.images![0]).toEqual({ id: "i1", src: "media/x.png", x: 0, y: 0, width: 100, height: 50 });
  });

  it("switches maps on `map <path>` and creates them implicitly", () => {
    const g = parseFlowgo("node b1 root 0 0\nmap /b1\nnode c1 child 0 0\n");
    expect(g.maps!.map((m) => m.path)).toEqual(["/", "/b1"]);
    expect(g.maps![1]!.boxes!).toEqual([{ id: "c1", label: "child", x: 0, y: 0 }]);
  });

  it("throws on an unknown directive", () => {
    expect(() => parseFlowgo("bogus 1 2 3\n")).toThrow(FlowgoParseError);
  });

  it("throws when an annotation refers to an unknown id", () => {
    expect(() => parseFlowgo("anchor nope\n")).toThrow(/unknown node/);
  });

  // A leading UTF-8 BOM is stripped rather than rejected, matching
  // pkg/graph.Parse (which used to error on it — see
  // TestLeadingBOMIsStripped in pkg/graph/parity_test.go). It already
  // works here because String.prototype.trim() treats U+FEFF as
  // whitespace, so this pins the existing (correct) behavior against
  // regression rather than fixing a bug on this side.
  it("tolerates a leading BOM", () => {
    const g = parseFlowgo("﻿version 1.2.3\nnode b1 hi 0 0\n");
    expect(g.version).toBe("1.2.3");
    expect(g.maps![0]!.boxes!).toHaveLength(1);
  });

  // Splitting on /\r\n|\r|\n/ already treats a lone `\r` as a line
  // break here; pins the same behavior pkg/graph.Parse was fixed to
  // match (TestLoneCarriageReturnSplitsLikeTS).
  it("treats a lone carriage return as a line ending", () => {
    const g = parseFlowgo("node b1 hi 0 0\rnode b2 lo 10 10\r");
    expect(g.maps![0]!.boxes!).toHaveLength(2);
    expect(g.maps![0]!.boxes!.map((b) => b.id)).toEqual(["b1", "b2"]);
  });

  // Numeric grammar pkg/graph.Parse now shares (parseFloatStrict /
  // parseIntStrict in pkg/graph/numparse.go): no Inf/NaN words, no
  // "1_000" digit separators, no hex, no leading "+", and — the case
  // that needed fixing here — no surrounding whitespace (JS's
  // Number() silently trims it, so " 12 " used to parse as 12).
  it.each(["Inf", "-Inf", "NaN", "1_000", "0x1p4", "0x10", "+5", "Infinity"])(
    "rejects numeric token %j",
    (tok) => {
      expect(() => parseFlowgo(`node b1 hi ${tok} 0\n`)).toThrow(FlowgoParseError);
    },
  );

  it.each(['"12 "', '" 12"', '" 12 "'])(
    "rejects whitespace-padded quoted numeric token %s",
    (tok) => {
      expect(() => parseFlowgo(`node b1 hi ${tok} 0\n`)).toThrow(FlowgoParseError);
    },
  );

  it("still accepts plain decimal, negative, and exponent numbers", () => {
    for (const tok of ["0", "-0", "5", "-5", "3.14", "-3.14", "1e10", "1E10", "1e-10", "1.5e+10", "1000000", "0.0001"]) {
      expect(() => parseFlowgo(`node b1 hi ${tok} 0\n`)).not.toThrow();
    }
  });

  it("rejects a `+`-prefixed integer field (palette)", () => {
    expect(() => parseFlowgo("node b1 hi 0 0 4 +5\n")).toThrow(FlowgoParseError);
  });

  it("round-trips through serializeGraph for a graph exercising every entity", () => {
    const original: ConcreteGraph = {
      version: "0.3.0",
      defaultShape: 1,
      maps: [
        {
          path: "/",
          boxes: [
            { id: "b1", label: "Alpha Beta", x: 1, y: 2, palette: 3, font: 4 },
            { id: "b2", label: "hex", x: 10, y: 20, shape: 1, anchor: true },
            { id: "b3", label: "sized", x: 5, y: 5, w: 120, h: 60 },
          ],
          edges: [{ from: "b1", to: "b2", fromHandle: "t", toHandle: "bl", palette: 6, label: "depends on" }],
          texts: [{ id: "t1", label: "hello\nworld", x: 3, y: 4, palette: 2, font: 5 }],
          lines: [{ id: "l1", x1: 0, y1: 0, x2: 9, y2: 9, palette: 7, style: 2, mids: [[3, 3], [6, 6]] }],
          strokes: [{ id: "s1", points: [[0, 0], [1, 1], [2, 2]], palette: 8 }],
          images: [{ id: "i1", src: "flowgo-media/abc.png", x: 1, y: 1, width: 40, height: 30 }],
        },
      ],
    };
    const text = serializeGraph(original);
    const parsed = parseFlowgo(text);
    expect(parsed.version).toBe(original.version);
    expect(parsed.defaultShape).toBe(original.defaultShape);
    // The anchor directive walks every box on its map and explicitly
    // clears anchor=false on the ones that aren't it (mirrors
    // pkg/graph.Parse) — so b1/b3 come back with anchor:false rather
    // than the key simply being absent, as in the input fixture.
    expect(parsed.maps).toEqual([
      {
        ...original.maps![0],
        boxes: original.maps![0]!.boxes!.map((b) => ({ anchor: false, ...b })),
      },
    ]);
  });

  it("parses the checked-in demo fixture (pkg/graph/map.flowgo) without throwing", () => {
    const fixturePath = fileURLToPath(new URL("../../pkg/graph/map.flowgo", import.meta.url));
    const text = readFileSync(fixturePath, "utf8");
    const g = parseFlowgo(text);
    expect(g.version).toBe("0.1.0");
    const root = g.maps!.find((m) => m.path === "/")!;
    expect(root.boxes!.find((b) => b.id === "b2")).toMatchObject({
      label: "FlowGo",
      palette: 7,
      font: 8,
      anchor: true,
    });
    // Nested submaps up to five levels deep (used to probe drill-in UI).
    expect(g.maps!.some((m) => m.path === "/b4/b1/b1/b1/b1/b1")).toBe(true);
  });
});
