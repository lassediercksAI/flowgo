// Mirror of the Go serializer in pkg/graph: turns an in-memory Graph
// into the .flowgo text format. Used by the in-browser Download
// button so the file we hand the user is byte-equivalent to what the
// Go binary would write.

import type { GraphLike, MapLike } from "./submap";

export interface BoxData {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly sides?: number | undefined;
  readonly palette?: number | undefined;
  readonly font?: number | undefined;
  readonly rotation?: number | undefined;
  readonly anchor?: boolean | undefined;
}

export interface EdgeData {
  readonly from: string;
  readonly to: string;
  readonly fromHandle?: string | undefined;
  readonly toHandle?: string | undefined;
  readonly palette?: number | undefined;
}

export interface TextData {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly palette?: number | undefined;
  readonly font?: number | undefined;
}

export interface LineData {
  readonly id: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly palette?: number | undefined;
}

export interface StrokeData {
  readonly id: string;
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly palette?: number | undefined;
}

export interface ConcreteMap extends MapLike {
  readonly boxes?: ReadonlyArray<BoxData>;
  readonly edges?: ReadonlyArray<EdgeData>;
  readonly texts?: ReadonlyArray<TextData>;
  readonly lines?: ReadonlyArray<LineData>;
  readonly strokes?: ReadonlyArray<StrokeData>;
}

export interface ConcreteGraph extends GraphLike {
  readonly maps?: ReadonlyArray<ConcreteMap>;
}

// Quote a label only when it would otherwise tokenise wrong (contains
// whitespace, a quote, or a backslash). Mirrors quote() in pkg/graph.
// Newlines round-trip as the escape `\n` since the .flowgo text format
// is line-based — a literal newline in a quoted value would split the
// directive across input lines and corrupt parsing.
export const flowgoQuote = (s: string): string => {
  if (s === "" || /[\s"\\]/.test(s)) {
    const escaped = s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
    return `"${escaped}"`;
  }
  return s;
};

// Plain number formatter — keeps integers integer-shaped, floats
// passed through as-is. Matches `%g` semantics close enough that the
// browser-side .flowgo file round-trips through the Go parser.
export const flowgoNum = (n: number): string => String(n);

const isSidesValue = (n: number | undefined): n is 3 | 5 | 6 =>
  n === 3 || n === 5 || n === 6;

const isPaletteOrFont = (n: number | undefined): boolean =>
  typeof n === "number" && n >= 2 && n <= 9;

export const serializeGraph = (g: ConcreteGraph): string => {
  const maps = (g.maps ?? []).filter(
    (m) =>
      (m.boxes?.length ?? 0) > 0 ||
      (m.edges?.length ?? 0) > 0 ||
      (m.texts?.length ?? 0) > 0 ||
      (m.lines?.length ?? 0) > 0 ||
      (m.strokes?.length ?? 0) > 0,
  );
  const multi = maps.length > 1;
  let out = "";

  maps.forEach((m, i) => {
    if (i > 0) out += "\n";
    if (multi || m.path !== "/") out += `map ${m.path}\n`;

    for (const b of m.boxes ?? []) {
      let line = `box ${b.id} ${flowgoQuote(b.label)} ${flowgoNum(b.x)} ${flowgoNum(b.y)}`;
      const sidesTok = isSidesValue(b.sides) ? b.sides : 0;
      const paletteTok = isPaletteOrFont(b.palette) ? b.palette! : 0;
      const fontTok = isPaletteOrFont(b.font) ? b.font! : 0;
      const rotTok = typeof b.rotation === "number" && b.rotation !== 0
        ? ((b.rotation % 360) + 360) % 360
        : 0;
      if (sidesTok || paletteTok || fontTok || rotTok) line += " " + (sidesTok || 4);
      if (paletteTok || fontTok || rotTok) line += " " + (paletteTok || 1);
      if (fontTok || rotTok) line += " " + (fontTok || 1);
      if (rotTok) line += " " + rotTok;
      out += line + "\n";
    }

    // Single-anchor invariant: emit at most one `anchor <id>` line.
    const anchored = (m.boxes ?? []).find((b) => b.anchor);
    if (anchored) out += `anchor ${anchored.id}\n`;

    if ((m.boxes?.length ?? 0) && (m.edges?.length ?? 0)) out += "\n";
    for (const e of m.edges ?? []) {
      const f = e.fromHandle ? `${e.from}:${e.fromHandle}` : e.from;
      const t = e.toHandle ? `${e.to}:${e.toHandle}` : e.to;
      let line = `edge ${f} ${t}`;
      if (isPaletteOrFont(e.palette)) line += " " + e.palette;
      out += line + "\n";
    }

    const beforeTexts =
      (m.boxes?.length ?? 0) > 0 || (m.edges?.length ?? 0) > 0;
    if (beforeTexts && (m.texts?.length ?? 0)) out += "\n";
    for (const t of m.texts ?? []) {
      let line = `text ${t.id} ${flowgoQuote(t.label)} ${flowgoNum(t.x)} ${flowgoNum(t.y)}`;
      const paletteTok = isPaletteOrFont(t.palette) ? t.palette! : 0;
      const fontTok = isPaletteOrFont(t.font) ? t.font! : 0;
      if (paletteTok || fontTok) line += " " + (paletteTok || 1);
      if (fontTok) line += " " + fontTok;
      out += line + "\n";
    }

    const beforeLines = beforeTexts || (m.texts?.length ?? 0) > 0;
    if (beforeLines && (m.lines?.length ?? 0)) out += "\n";
    for (const l of m.lines ?? []) {
      let line = `line ${l.id} ${flowgoNum(l.x1)} ${flowgoNum(l.y1)} ${flowgoNum(l.x2)} ${flowgoNum(l.y2)}`;
      if (isPaletteOrFont(l.palette)) line += " " + l.palette;
      out += line + "\n";
    }

    const beforeStrokes = beforeLines || (m.lines?.length ?? 0) > 0;
    if (beforeStrokes && (m.strokes?.length ?? 0)) out += "\n";
    for (const s of m.strokes ?? []) {
      if ((s.points?.length ?? 0) < 2) continue;
      const pairs = s.points
        .map((p) => `${flowgoNum(p[0])},${flowgoNum(p[1])}`)
        .join(" ");
      const pal = isPaletteOrFont(s.palette) ? ` ${s.palette}` : "";
      out += `stroke ${s.id}${pal} ${pairs}\n`;
    }
  });

  return out;
};
