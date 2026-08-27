package graph

import (
	"fmt"
	"regexp"
	"strconv"
)

// strictFloatRe and strictIntRe define the one numeric grammar both
// pkg/graph.Parse and src/graph/parse.ts accept. Go's strconv.ParseFloat
// and strconv.Atoi are individually more permissive than this — they
// take "Inf", "NaN", "1_000" (digit-separator underscores),
// "0x1p4"/hex, and a leading "+" — and JS's Number(), which backs the
// TS parser's `num()`, is permissive in an overlapping but different
// way: it additionally accepts "0x10" (bare hex int) and " 12 "
// (leading/trailing whitespace, which it silently trims). None of
// that is ever emitted by either serializer, so a file exploiting it
// only exists to probe or exploit the gap between the two parsers —
// accepted by one, rejected by the other, or interpreted differently
// by both (e.g. "0x10" is 16 as a JS number but not a Go one at all).
// Restricting both parsers to the same plain-decimal grammar closes
// that gap instead of trying to keep chasing it wider.
var (
	strictFloatRe = regexp.MustCompile(`^-?\d+(\.\d+)?([eE][-+]?\d+)?$`)
	strictIntRe   = regexp.MustCompile(`^-?\d+$`)
)

// parseFloatStrict is strconv.ParseFloat gated by strictFloatRe. Used
// for every coordinate / size field Parse reads, in place of a bare
// strconv.ParseFloat call.
func parseFloatStrict(s string) (float64, error) {
	if !strictFloatRe.MatchString(s) {
		return 0, fmt.Errorf("not a plain decimal number: %q", s)
	}
	return strconv.ParseFloat(s, 64)
}

// parseIntStrict is strconv.Atoi gated by strictIntRe. Used for every
// integer field Parse reads (palette, font, shape, style, sides,
// rotation, ...), in place of a bare strconv.Atoi call.
func parseIntStrict(s string) (int, error) {
	if !strictIntRe.MatchString(s) {
		return 0, fmt.Errorf("not a plain decimal integer: %q", s)
	}
	return strconv.Atoi(s)
}
