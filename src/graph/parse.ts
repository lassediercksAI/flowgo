// TypeScript port of pkg/graph.Parse (see pkg/graph/graph.go). The
// browser side has never needed this before — the Go binary always
// handed the editor JSON over /state — but a network-free standalone
// consumer (embeddable renderer, browser extension, static-site
// plugin) needs to turn raw .flowgo text into a graph without a
// server in the loop. Keep this in lockstep with the Go parser: same
// directives, same tolerant/strict split (unknown directive throws;
// out-of-range style values are ignored, mirroring the Go comments).

import type { ConcreteGraph, ConcreteMap } from "./serialize";

export class FlowgoParseError extends Error {}

const tokenize = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let escape = false;
  // `quoted` records that the token being accumulated opened a quote,
  // so an explicitly empty value survives. Without it `node b1 "" 0 0`
  // — what the serializer writes for a node with no label — tokenizes
  // to four tokens and the line is rejected, which makes the whole
  // file unreadable. Mirrors tokenize() in pkg/graph.
  let quoted = false;
  const flush = (): void => {
    if (cur.length > 0 || quoted) {
      out.push(cur);
      cur = "";
      quoted = false;
    }
  };
  for (const ch of line) {
    if (escape) {
      cur += ch === "n" ? "\n" : ch;
      escape = false;
    } else if (ch === "\\") {
      escape = true;
    } else if (ch === '"') {
      inQuote = !inQuote;
      quoted = true;
    } else if (!inQuote && (ch === " " || ch === "\t")) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return out;
};

const splitEndpoint = (s: string): [string, string] => {
  const i = s.indexOf(":");
  return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ""];
};

// Matches STRICT_FLOAT_RE in pkg/graph/numparse.go — the one numeric
// grammar both parsers accept. Plain `Number(s)` is more permissive
// than this in ways that don't match pkg/graph's strconv.ParseFloat:
// it trims surrounding whitespace ("` 12 `" -> 12) and accepts bare
// hex ("0x10" -> 16), so a hand-crafted file used to parse here and
// fail (or parse differently) in Go. Neither form is ever emitted by
// either serializer, so rejecting both closes the gap instead of
// chasing it wider.
const STRICT_NUMBER_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

const num = (s: string, lineNo: number, what: string): number => {
  if (!STRICT_NUMBER_RE.test(s)) {
    throw new FlowgoParseError(`line ${lineNo}: bad ${what}: ${JSON.stringify(s)}`);
  }
  const v = Number(s);
  // Guards a digit string long enough to overflow to Infinity (e.g. a
  // "1" followed by hundreds of zeros) — the regex alone can't rule
  // that out, but Infinity is exactly as unusable here as the word
  // "Infinity" itself would be.
  if (!Number.isFinite(v)) {
    throw new FlowgoParseError(`line ${lineNo}: bad ${what}: ${JSON.stringify(s)}`);
  }
  return v;
};

const int = (s: string, lineNo: number, what: string): number => {
  if (!/^-?\d+$/.test(s)) {
    throw new FlowgoParseError(`line ${lineNo}: bad ${what}: ${JSON.stringify(s)}`);
  }
  return parseInt(s, 10);
};

interface MutMap {
  path: string;
  boxes: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
    palette?: number;
    font?: number;
    anchor?: boolean;
    w?: number;
    h?: number;
    shape?: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    fromHandle?: string;
    toHandle?: string;
    palette?: number;
    label?: string;
  }>;
  texts: Array<{
    id: string;
    label: string;
    x: number;
    y: number;
    palette?: number;
    font?: number;
  }>;
  lines: Array<{
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    palette?: number;
    style?: number;
    mids?: Array<[number, number]>;
  }>;
  strokes: Array<{ id: string; points: Array<[number, number]>; palette?: number }>;
  images: Array<{
    id: string;
    src: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

// Parse the .flowgo text format into a graph. Mirrors pkg/graph.Parse
// directive-for-directive, including the legacy box/boxsize/boxshape
// spellings and the pre-defaultshape `hexagons on/off` directive.
// Throws FlowgoParseError on malformed or unknown directives — same
// fail-loud posture as the Go parser.
export const parseFlowgo = (text: string): ConcreteGraph => {
  const maps: MutMap[] = [];
  const findOrCreate = (path: string): MutMap => {
    let m = maps.find((m) => m.path === path);
    if (!m) {
      m = { path, boxes: [], edges: [], texts: [], lines: [], strokes: [], images: [] };
      maps.push(m);
    }
    return m;
  };
  let cur = findOrCreate("/");
  let version: string | undefined;
  let defaultShape = 0;

  const lines = text.split(/\r\n|\r|\n/);
  for (let lineNo = 1; lineNo <= lines.length; lineNo++) {
    const raw = lines[lineNo - 1]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const toks = tokenize(raw);
    // An empty leading token means the line opens with `""`, which is
    // not a directive. Skipping keeps such a line ignored exactly as it
    // was before tokenize learned to emit empty quoted values — turning
    // a previously-tolerated line into a hard parse error would itself
    // make files unopenable. Mirrors pkg/graph.Parse.
    if (toks.length === 0 || toks[0] === "") continue;
    const kw = toks[0]!;

    switch (kw) {
      case "version": {
        if (toks.length < 2) throw new FlowgoParseError(`line ${lineNo}: version needs a value`);
        version = toks[1];
        break;
      }
      case "hexagons": {
        if (toks.length < 2) {
          if (defaultShape === 0) defaultShape = 1;
          break;
        }
        if (toks[1] === "on" || toks[1] === "1" || toks[1] === "true") {
          if (defaultShape === 0) defaultShape = 1;
        } else if (toks[1] === "off" || toks[1] === "0" || toks[1] === "false") {
          // no-op
        } else {
          throw new FlowgoParseError(`line ${lineNo}: hexagons wants on or off, got ${JSON.stringify(toks[1])}`);
        }
        break;
      }
      case "defaultshape": {
        if (toks.length < 2) throw new FlowgoParseError(`line ${lineNo}: defaultshape needs a value`);
        const v = int(toks[1]!, lineNo, "defaultshape");
        if (v >= 1 && v <= 9) defaultShape = v;
        break;
      }
      case "map": {
        if (toks.length < 2) throw new FlowgoParseError(`line ${lineNo}: map needs path`);
        cur = findOrCreate(toks[1]!);
        break;
      }
      case "node":
      case "box": {
        if (toks.length < 5) throw new FlowgoParseError(`line ${lineNo}: ${kw} needs id label x y`);
        const x = num(toks[3]!, lineNo, "x");
        const y = num(toks[4]!, lineNo, "y");
        const box: MutMap["boxes"][number] = { id: toks[1]!, label: toks[2]!, x, y };
        if (toks.length >= 6) int(toks[5]!, lineNo, "sides"); // vestigial, validate-and-discard
        if (toks.length >= 7) {
          const p = int(toks[6]!, lineNo, "palette");
          if (p >= 2 && p <= 9) box.palette = p;
        }
        if (toks.length >= 8) {
          const f = int(toks[7]!, lineNo, "font");
          if (f >= 2 && f <= 9) box.font = f;
        }
        if (toks.length >= 9) int(toks[8]!, lineNo, "rotation"); // vestigial, validate-and-discard
        cur.boxes.push(box);
        break;
      }
      case "edge": {
        if (toks.length < 3) throw new FlowgoParseError(`line ${lineNo}: edge needs from to`);
        const [fromID, fromH] = splitEndpoint(toks[1]!);
        const [toID, toH] = splitEndpoint(toks[2]!);
        const edge: MutMap["edges"][number] = { from: fromID, to: toID };
        if (fromH) edge.fromHandle = fromH;
        if (toH) edge.toHandle = toH;
        if (toks.length >= 4) {
          const p = int(toks[3]!, lineNo, "edge palette");
          if (p >= 2 && p <= 9) edge.palette = p;
        }
        // Slot 5 is the edge label — it sits behind the palette
        // because slot 4 was already the palette (see EdgeData.label
        // in serialize.ts). An empty label is never written, so an
        // empty token here just round-trips as "no label".
        const edgeLabel = toks[4];
        if (edgeLabel !== undefined && edgeLabel !== "") edge.label = edgeLabel;
        cur.edges.push(edge);
        break;
      }
      case "text": {
        if (toks.length < 5) throw new FlowgoParseError(`line ${lineNo}: text needs id label x y`);
        const x = num(toks[3]!, lineNo, "x");
        const y = num(toks[4]!, lineNo, "y");
        const t: MutMap["texts"][number] = { id: toks[1]!, label: toks[2]!, x, y };
        if (toks.length >= 6) {
          const p = int(toks[5]!, lineNo, "text palette");
          if (p >= 2 && p <= 9) t.palette = p;
        }
        if (toks.length >= 7) {
          const f = int(toks[6]!, lineNo, "text font");
          if (f >= 2 && f <= 9) t.font = f;
        }
        cur.texts.push(t);
        break;
      }
      case "line": {
        if (toks.length < 6) throw new FlowgoParseError(`line ${lineNo}: line needs id x1 y1 x2 y2`);
        const x1 = num(toks[2]!, lineNo, "coord");
        const y1 = num(toks[3]!, lineNo, "coord");
        const x2 = num(toks[4]!, lineNo, "coord");
        const y2 = num(toks[5]!, lineNo, "coord");
        const ln: MutMap["lines"][number] = { id: toks[1]!, x1, y1, x2, y2 };
        if (toks.length >= 7) {
          const p = int(toks[6]!, lineNo, "line palette");
          if (p >= 2 && p <= 9) ln.palette = p;
        }
        if (toks.length > 7) {
          if ((toks.length - 7) % 2 !== 0) {
            throw new FlowgoParseError(`line ${lineNo}: line mids need pairs of coords`);
          }
          const mids: Array<[number, number]> = [];
          for (let i = 7; i < toks.length; i += 2) {
            mids.push([num(toks[i]!, lineNo, "line mid x"), num(toks[i + 1]!, lineNo, "line mid y")]);
          }
          ln.mids = mids;
        }
        cur.lines.push(ln);
        break;
      }
      case "linestyle": {
        if (toks.length < 3) throw new FlowgoParseError(`line ${lineNo}: linestyle needs id and style`);
        const v = int(toks[2]!, lineNo, "linestyle");
        if (v < 2 || v > 9) break;
        const ln = cur.lines.find((l) => l.id === toks[1]);
        if (!ln) throw new FlowgoParseError(`line ${lineNo}: linestyle refers to unknown line ${JSON.stringify(toks[1])}`);
        ln.style = v;
        break;
      }
      case "nodesize":
      case "boxsize": {
        if (toks.length < 4) throw new FlowgoParseError(`line ${lineNo}: ${kw} needs id, width, and height`);
        const w = num(toks[2]!, lineNo, `${kw} width`);
        const h = num(toks[3]!, lineNo, `${kw} height`);
        if (w <= 0 || h <= 0) break;
        const box = cur.boxes.find((b) => b.id === toks[1]);
        if (!box) throw new FlowgoParseError(`line ${lineNo}: ${kw} refers to unknown node ${JSON.stringify(toks[1])}`);
        box.w = w;
        box.h = h;
        break;
      }
      case "nodeshape":
      case "boxshape": {
        if (toks.length < 3) throw new FlowgoParseError(`line ${lineNo}: ${kw} needs id and shape`);
        const v = int(toks[2]!, lineNo, kw);
        if (v < 1 || v > 9) break;
        const box = cur.boxes.find((b) => b.id === toks[1]);
        if (!box) throw new FlowgoParseError(`line ${lineNo}: ${kw} refers to unknown node ${JSON.stringify(toks[1])}`);
        box.shape = v;
        break;
      }
      case "anchor": {
        if (toks.length < 2) throw new FlowgoParseError(`line ${lineNo}: anchor needs id`);
        const id = toks[1]!;
        let found = false;
        for (const b of cur.boxes) {
          if (b.id === id) {
            b.anchor = true;
            found = true;
          } else {
            b.anchor = false;
          }
        }
        if (!found) throw new FlowgoParseError(`line ${lineNo}: anchor refers to unknown node ${JSON.stringify(id)}`);
        break;
      }
      case "stroke": {
        if (toks.length < 4) throw new FlowgoParseError(`line ${lineNo}: stroke needs id and at least two points`);
        let pointStart = 2;
        let palette = 0;
        if (!toks[2]!.includes(",")) {
          palette = int(toks[2]!, lineNo, "stroke palette");
          pointStart = 3;
          if (toks.length < 5) throw new FlowgoParseError(`line ${lineNo}: stroke needs at least two points`);
        }
        const points: Array<[number, number]> = [];
        for (let i = pointStart; i < toks.length; i++) {
          const parts = toks[i]!.split(",");
          if (parts.length !== 2) throw new FlowgoParseError(`line ${lineNo}: bad stroke point ${JSON.stringify(toks[i])}`);
          points.push([num(parts[0]!, lineNo, "stroke x"), num(parts[1]!, lineNo, "stroke y")]);
        }
        const s: MutMap["strokes"][number] = { id: toks[1]!, points };
        if (palette >= 2 && palette <= 9) s.palette = palette;
        cur.strokes.push(s);
        break;
      }
      case "image": {
        if (toks.length < 7) throw new FlowgoParseError(`line ${lineNo}: image needs id src x y width height`);
        cur.images.push({
          id: toks[1]!,
          src: toks[2]!,
          x: num(toks[3]!, lineNo, "image coord"),
          y: num(toks[4]!, lineNo, "image coord"),
          width: num(toks[5]!, lineNo, "image coord"),
          height: num(toks[6]!, lineNo, "image coord"),
        });
        break;
      }
      default:
        throw new FlowgoParseError(`line ${lineNo}: unknown directive ${JSON.stringify(kw)}`);
    }
  }

  const out: ConcreteGraph = { maps: maps as ConcreteMap[] };
  if (version) (out as { version?: string }).version = version;
  if (defaultShape >= 1 && defaultShape <= 9) {
    (out as { defaultShape?: number }).defaultShape = defaultShape;
  }
  return out;
};
