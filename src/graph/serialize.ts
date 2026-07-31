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
  readonly palette?: number | undefined;
  readonly font?: number | undefined;
  readonly anchor?: boolean | undefined;
  // Explicit on-canvas size in data px (both set = user resized the
  // box; absent = auto-size to the label). Serialized as a separate
  // `boxsize <id> <w> <h>` directive, mirroring pkg/graph.
  readonly w?: number | undefined;
  readonly h?: number | undefined;
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
  // Intermediate control points. The line always runs through every
  // mid; the segment style between consecutive points is governed by
  // `style`.
  readonly mids?: ReadonlyArray<readonly [number, number]> | undefined;
  // 1 (or unset) = straight polyline, 2 = smooth bezier chain,
  // 3 = orthogonal elbows. 4-9 reserved.
  readonly style?: number | undefined;
}

export interface StrokeData {
  readonly id: string;
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly palette?: number | undefined;
}

export interface ImageData {
  readonly id: string;
  // Path relative to the .flowgo file, e.g. "flowgo-media/<hash>.png".
  readonly src: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ConcreteMap extends MapLike {
  readonly boxes?: ReadonlyArray<BoxData>;
  readonly edges?: ReadonlyArray<EdgeData>;
  readonly texts?: ReadonlyArray<TextData>;
  readonly lines?: ReadonlyArray<LineData>;
  readonly strokes?: ReadonlyArray<StrokeData>;
  readonly images?: ReadonlyArray<ImageData>;
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

const isPaletteOrFont = (n: number | undefined): boolean =>
  typeof n === "number" && n >= 2 && n <= 9;

export const serializeGraph = (g: ConcreteGraph): string => {
  const maps = (g.maps ?? []).filter(
    (m) =>
      (m.boxes?.length ?? 0) > 0 ||
      (m.edges?.length ?? 0) > 0 ||
      (m.texts?.length ?? 0) > 0 ||
      (m.lines?.length ?? 0) > 0 ||
      (m.strokes?.length ?? 0) > 0 ||
      (m.images?.length ?? 0) > 0,
  );
  const multi = maps.length > 1;
  let out = "";
  if (g.version) out += `version ${g.version}\n`;

  maps.forEach((m, i) => {
    if (i > 0) out += "\n";
    if (multi || m.path !== "/") out += `map ${m.path}\n`;

    for (const b of m.boxes ?? []) {
      let line = `box ${b.id} ${flowgoQuote(b.label)} ${flowgoNum(b.x)} ${flowgoNum(b.y)}`;
      const paletteTok = isPaletteOrFont(b.palette) ? b.palette! : 0;
      const fontTok = isPaletteOrFont(b.font) ? b.font! : 0;
      // "4" is a vestigial placeholder for the old sides slot, kept so
      // old binaries can still parse files written by 0.0.24+.
      if (paletteTok || fontTok) line += " 4";
      if (paletteTok || fontTok) line += " " + (paletteTok || 1);
      if (fontTok) line += " " + fontTok;
      out += line + "\n";
    }

    // boxsize directives follow the box block (like linestyle after
    // lines) so parsers see the box before its size annotation.
    for (const b of m.boxes ?? []) {
      if (b.w !== undefined && b.h !== undefined && b.w > 0 && b.h > 0) {
        out += `boxsize ${b.id} ${flowgoNum(b.w)} ${flowgoNum(b.h)}\n`;
      }
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
      const mids = l.mids ?? [];
      if (isPaletteOrFont(l.palette) || mids.length > 0) {
        // When mids are present without an explicit palette we emit
        // the default sentinel "1" so the mid coordinates land in a
        // stable positional slot. The parser ignores palette=1.
        const palTok = isPaletteOrFont(l.palette) ? l.palette : 1;
        line += " " + palTok;
      }
      for (const [mx, my] of mids) {
        line += ` ${flowgoNum(mx)} ${flowgoNum(my)}`;
      }
      out += line + "\n";
    }
    // linestyle directives follow the line block so older flowgo
    // binaries unaware of styles still parse the geometry cleanly.
    for (const l of m.lines ?? []) {
      if (typeof l.style === "number" && l.style >= 2 && l.style <= 9) {
        out += `linestyle ${l.id} ${l.style}\n`;
      }
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

    const beforeImages =
      beforeStrokes || (m.strokes?.length ?? 0) > 0;
    if (beforeImages && (m.images?.length ?? 0)) out += "\n";
    for (const img of m.images ?? []) {
      out += `image ${img.id} ${flowgoQuote(img.src)} ${flowgoNum(img.x)} ${flowgoNum(img.y)} ${flowgoNum(img.width)} ${flowgoNum(img.height)}\n`;
    }
  });

  return out;
};
