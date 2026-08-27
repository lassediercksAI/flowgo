// Label normalisation: a single, pure transform applied to anything
// the user typed/pasted into a contenteditable region. Newlines are
// preserved (they render as hard line breaks in the box / text item),
// but every other whitespace run — spaces, tabs, NBSP, and friends —
// collapses to a single space. Per-line leading/trailing whitespace
// is trimmed, and fully blank leading/trailing lines are dropped.
// The result is hard-capped to `maxLength` characters so a 100kB
// paste can't blow up the file.

export const MAX_LABEL_LEN = 500;

export interface NormalizeOptions {
  readonly maxLength?: number;
}

export interface NormalizeResult {
  readonly label: string;
  readonly truncated: boolean;
}

// Match any whitespace *except* newline. Equivalent to \s minus \n.
const NON_NEWLINE_WS = /[^\S\n]+/g;

// Counts and truncates by Unicode codepoint, not UTF-16 code unit.
// Plain `string.length` / `string.slice` count UTF-16 units, so a
// label built from astral-plane characters (many emoji, some CJK
// extension characters) reaches MAX_LABEL_LEN at half as many visible
// characters as intended, and a naive `.slice(0, cap)` can cut a
// surrogate pair in half, producing an unpaired surrogate that mangles
// on the next render or re-encode. Iterating a string with `for...of`
// (like the spread here) walks whole codepoints, matching
// pkg/graph.NormalizeLabel's `[]rune` cap in label.go — the two must
// agree since MAX_LABEL_LEN / MaxLabelLen is one shared cap enforced
// on both sides of the wire.
const codePointLength = (s: string): number => Array.from(s).length;

const codePointSlice = (s: string, end: number): string => {
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n >= end) break;
    out += ch;
    n++;
  }
  return out;
};

export const normalizeLabel = (
  raw: string | null | undefined,
  opts: NormalizeOptions = {},
): NormalizeResult => {
  const cap = opts.maxLength ?? MAX_LABEL_LEN;
  const text = (raw ?? "").replace(/\r\n?/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.replace(NON_NEWLINE_WS, " ").trim());
  // Drop fully-empty leading / trailing lines while keeping interior
  // blank lines (a user might Shift+Enter twice for a paragraph gap).
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  const collapsed = lines.slice(start, end).join("\n");
  if (codePointLength(collapsed) > cap) {
    return { label: codePointSlice(collapsed, cap), truncated: true };
  }
  return { label: collapsed, truncated: false };
};
