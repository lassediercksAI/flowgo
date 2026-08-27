// The .flowgo file is the whole document, so bytes one parser accepts
// and the other rejects are a data-loss bug, not a cosmetic one. These
// tests pin the browser half of the contract that pkg/graph's
// integrity_test.go pins on the Go side (brain#245).

import { describe, expect, it } from "vitest";
import { flowgoQuote, flowgoQuoteId, serializeGraph } from "./serialize";
import type { ConcreteGraph } from "./serialize";
import { parseFlowgo } from "./parse";

const roundTrip = (g: ConcreteGraph): ConcreteGraph => {
  const text = serializeGraph(g);
  // A raw CR would be a line break to this parser and an ordinary
  // character to Go's scanner — the two would read the same file
  // differently, so the serializer must never emit one.
  expect(text).not.toContain("\r");
  return parseFlowgo(text) as ConcreteGraph;
};

describe("carriage returns in labels", () => {
  it("folds CR and CRLF into the newline escape", () => {
    expect(flowgoQuote("a\rb")).toBe('"a\\nb"');
    expect(flowgoQuote("a\r\nb")).toBe('"a\\nb"');
    expect(flowgoQuote("a\n\rb")).toBe('"a\\n\\nb"');
  });

  it("round-trips a CR label as a newline instead of splitting the directive", () => {
    const g = roundTrip({
      maps: [{ path: "/", boxes: [{ id: "b1", label: "a\rb", x: 0, y: 0 }] }],
    });
    expect(g.maps![0]!.boxes![0]!.label).toBe("a\nb");
  });
});

describe("ids that would forge a directive", () => {
  it("leaves plain ids untouched, preserving byte parity with pkg/graph", () => {
    for (const id of ["b1", "t12", "kebab-case", "snake_case", "Ünïcödé", "日本語"]) {
      expect(flowgoQuoteId(id)).toBe(id);
    }
  });

  it("quotes an empty id rather than emitting a directive short one token", () => {
    expect(flowgoQuoteId("")).toBe('""');
    const g = roundTrip({
      maps: [{ path: "/", boxes: [{ id: "", label: "x", x: 0, y: 0 }] }],
    });
    expect(g.maps![0]!.boxes![0]).toMatchObject({ id: "", label: "x" });
  });

  it("quotes an id carrying whitespace so it cannot split its own line", () => {
    expect(flowgoQuoteId("b1 0 0\npwned")).toBe('"b1 0 0\\npwned"');
  });

  it("round-trips the brain#245 crafted id instead of producing an unparseable file", () => {
    const crafted = "b1 0 0\npwned";
    const g = roundTrip({
      maps: [{ path: "/", boxes: [{ id: crafted, label: "x", x: 0, y: 0 }] }],
    });
    expect(g.maps![0]!.boxes!).toHaveLength(1);
    expect(g.maps![0]!.boxes![0]!.id).toBe(crafted);
  });

  it("round-trips ids containing quotes and backslashes", () => {
    for (const id of ['b"1', "b\\1", "b 1", "b\t1"]) {
      const g = roundTrip({
        maps: [
          {
            path: "/",
            boxes: [
              { id, label: "x", x: 0, y: 0, w: 120, h: 40 },
              { id: "peer", label: "y", x: 0, y: 0 },
            ],
            edges: [{ from: id, to: "peer", fromHandle: "t" }],
          },
        ],
      });
      expect(g.maps![0]!.boxes![0]!.id).toBe(id);
      expect(g.maps![0]!.boxes![0]!.w).toBe(120);
      expect(g.maps![0]!.edges![0]).toMatchObject({ from: id, fromHandle: "t" });
    }
  });
});

describe("empty labels", () => {
  // `node b1 "" 0 0` used to tokenize to four tokens, so the parser
  // rejected the line and the whole document became unreadable —
  // clearing a node's text was enough to lose the file.
  it("survives the round-trip", () => {
    const g = roundTrip({
      maps: [
        {
          path: "/",
          boxes: [
            { id: "b1", label: "", x: 0, y: 0 },
            { id: "b2", label: "kept", x: 10, y: 0 },
          ],
          texts: [{ id: "t1", label: "", x: 0, y: 0 }],
        },
      ],
    });
    expect(g.maps![0]!.boxes!.map((b) => b.label)).toEqual(["", "kept"]);
    expect(g.maps![0]!.texts![0]!.label).toBe("");
  });

  it("keeps ignoring a line that opens with an empty quoted token", () => {
    // Previously such a line produced no tokens and was skipped;
    // turning it into a hard error would make files that open today
    // unopenable.
    const g = parseFlowgo('node b1 hi 0 0\n""\n');
    expect(g.maps![0]!.boxes!).toHaveLength(1);
  });
});

describe("map paths", () => {
  it("round-trips a path that would otherwise forge a directive", () => {
    const path = "/a\nnode evil x 0 0";
    const g = roundTrip({
      maps: [
        { path: "/", boxes: [{ id: "a", label: "A", x: 0, y: 0 }] },
        { path, boxes: [{ id: "b1", label: "x", x: 0, y: 0 }] },
      ],
    });
    expect(g.maps!.map((m) => m.path)).toEqual(["/", path]);
  });
});

describe("nasty labels", () => {
  const labels = [
    "plain",
    "with space",
    "with\ttab",
    "with\nnewline",
    'with "quotes"',
    "with \\backslash",
    "trailing backslash \\",
    "Ünïcödé — em dash",
    "emoji 🙂🎉",
    "node b2 forged 0 0",
    '"unbalanced',
    "",
  ];
  it.each(labels)("round-trips %j", (label) => {
    const g = roundTrip({
      maps: [{ path: "/", boxes: [{ id: "b1", label, x: 0, y: 0 }] }],
    });
    expect(g.maps![0]!.boxes![0]!.label).toBe(label);
  });
});

describe("version with a space", () => {
  // An unquoted `version <ver>` line tokenizes on whitespace like any
  // other directive, so a version containing a space used to
  // truncate to its first word on the next parse — silently, with no
  // error. Mirrors TestVersionWithSpaceRoundTrips in
  // pkg/graph/version_directive_test.go.
  it.each(["a b", "0.0.23 (custom build)", "has\ttab", 'has "quotes"'])(
    "round-trips %j",
    (version) => {
      const g = roundTrip({
        version,
        maps: [{ path: "/", boxes: [{ id: "b1", label: "hi", x: 0, y: 0 }] }],
      });
      expect(g.version).toBe(version);
    },
  );
});
