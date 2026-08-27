package graph

import (
	"strings"
	"testing"
)

// These pin the smaller Go/TS agreement gaps found alongside the
// three headline round-trip bugs: a leading BOM, a lone `\r` line
// ending, and the numeric grammar each parser's number tokens accept.
// In every case the fix converges Go on whichever side was already
// more forgiving, so a file that opened in the browser opens in the
// Go binary too (and vice versa).

// TestLeadingBOMIsStripped: src/graph/parse.ts tolerates a leading
// UTF-8 BOM because JS's String.trim() treats U+FEFF as whitespace
// and silently drops it from the first line. Parse used to have no
// equivalent tolerance, so a BOM-prefixed file — which a lot of
// Windows editors write by default — opened in the browser and failed
// in Go with "unknown directive" on the first line.
func TestLeadingBOMIsStripped(t *testing.T) {
	src := "\uFEFFversion 1.2.3\nnode b1 hi 0 0\n"
	g, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse rejected a leading BOM: %v", err)
	}
	if g.Version != "1.2.3" {
		t.Errorf("version = %q, want 1.2.3", g.Version)
	}
	if len(g.Maps) != 1 || len(g.Maps[0].Boxes) != 1 {
		t.Errorf("boxes not parsed: %+v", g.Maps)
	}
}

// TestLoneCarriageReturnSplitsLikeTS: src/graph/parse.ts splits input
// on /\r\n|\r|\n/, so a bare `\r` with no following `\n` ends a line
// there. Parse used to rely on bufio.Scanner's default ScanLines,
// which only recognizes `\n` (stripping an immediately preceding
// `\r`) — a lone `\r` stayed embedded in whatever token it fell
// inside, which usually broke that directive's parse. A file with
// old-Mac-style (`\r`-only) line endings therefore opened in the
// browser and errored in Go.
func TestLoneCarriageReturnSplitsLikeTS(t *testing.T) {
	src := "node b1 hi 0 0\rnode b2 lo 10 10\r"
	g, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse rejected lone-CR line endings: %v", err)
	}
	if len(g.Maps) != 1 || len(g.Maps[0].Boxes) != 2 {
		t.Fatalf("expected 2 boxes from 2 CR-separated lines, got %+v", g.Maps)
	}
	if g.Maps[0].Boxes[0].ID != "b1" || g.Maps[0].Boxes[1].ID != "b2" {
		t.Errorf("boxes = %+v", g.Maps[0].Boxes)
	}
}

// TestNumericTolerancesRejectedByBothParsers pins the numeric grammar
// both parsers now share. Before this fix, Go's strconv.ParseFloat
// accepted "Inf", "NaN", "1_000" (digit-separator underscores), and
// "0x1p4" (hex float) — none of which src/graph/parse.ts's `num()`
// accepted at the time, since JS's Number() rejects those forms too.
// Conversely, JS's Number() accepts "0x10" (bare hex int) and
// " 12 " (surrounding whitespace, silently trimmed) — Go's
// ParseFloat rejects both. A file exploiting either gap parsed on one
// side and failed (or, worse, parsed to a *different* value — "0x10"
// is 16 as a number but invalid to Go) on the other. Neither side
// should accept any of these; both must now reject the whole set.
func TestNumericTolerancesRejectedByBothParsers(t *testing.T) {
	bad := []string{"Inf", "-Inf", "NaN", "1_000", "0x1p4", "0x10", "+5", "infinity"}
	for _, tok := range bad {
		t.Run(tok, func(t *testing.T) {
			src := "node b1 hi " + tok + " 0\n"
			if _, err := Parse(src); err == nil {
				t.Errorf("Parse accepted numeric token %q, want a rejection", tok)
			}
		})
	}
}

// TestQuotedWhitespaceNumberRejected covers the case that needs a
// quoted token to reach the numeric parser at all — an unquoted
// space would just be a token delimiter. tokenize() (see graph.go)
// applies quote-processing uniformly to every token regardless of
// which directive it belongs to, so `node b1 hi "12 " 0` is a
// legal-to-tokenize line whose x field is the 4-byte string `12 `.
// JS's Number() trims that surrounding whitespace and accepts it
// (12); Go's strconv.ParseFloat rejects it outright. Both must now
// reject it.
func TestQuotedWhitespaceNumberRejected(t *testing.T) {
	for _, tok := range []string{`"12 "`, `" 12"`, `" 12 "`} {
		t.Run(tok, func(t *testing.T) {
			src := "node b1 hi " + tok + " 0\n"
			if _, err := Parse(src); err == nil {
				t.Errorf("Parse accepted whitespace-padded numeric token %s, want a rejection", tok)
			}
		})
	}
}

// TestPlainNumbersStillParse is the other half: the strict grammar
// must not have narrowed past what the format actually needs —
// negative numbers, decimals, and exponents all still have to work.
func TestPlainNumbersStillParse(t *testing.T) {
	ok := []string{"0", "-0", "5", "-5", "3.14", "-3.14", "1e10", "1E10", "1e-10", "1.5e+10", "1000000", "0.0001"}
	for _, tok := range ok {
		t.Run(tok, func(t *testing.T) {
			src := "node b1 hi " + tok + " 0\n"
			g, err := Parse(src)
			if err != nil {
				t.Fatalf("Parse rejected plain number %q: %v", tok, err)
			}
			if len(g.Maps[0].Boxes) != 1 {
				t.Fatalf("box not parsed for %q", tok)
			}
		})
	}
}

// TestNumericTolerancesRejectedInIntegerFields extends the same rule
// to integer-typed tokens (palette, sides, ...): Go's strconv.Atoi
// accepts a leading "+", which src/graph/parse.ts's `int()` already
// rejected via its `^-?\d+$` regex. "+5" as a palette used to parse
// on the Go side and error on the TS side.
func TestNumericTolerancesRejectedInIntegerFields(t *testing.T) {
	// toks: node id label x y sides palette -- palette is toks[6].
	src := "node b1 hi 0 0 4 +5\n"
	if _, err := Parse(src); err == nil {
		t.Error("Parse accepted a `+`-prefixed palette, want a rejection")
	}
}

func TestNumParityHelpersAgree(t *testing.T) {
	for _, tc := range []struct {
		s    string
		want bool
	}{
		{"5", true}, {"-5", true}, {"3.14", true}, {"1e10", true}, {"1E-10", true},
		{"+5", false}, {"Inf", false}, {"NaN", false}, {"1_000", false}, {"0x10", false},
		{" 12 ", false}, {"", false}, {".5", false}, {"5.", false},
	} {
		if _, err := parseFloatStrict(tc.s); (err == nil) != tc.want {
			t.Errorf("parseFloatStrict(%q): accepted=%v, want accepted=%v", tc.s, err == nil, tc.want)
		}
	}
	for _, tc := range []struct {
		s    string
		want bool
	}{
		{"5", true}, {"-5", true}, {"+5", false}, {"5.0", false}, {"0x10", false}, {"", false},
	} {
		if _, err := parseIntStrict(tc.s); (err == nil) != tc.want {
			t.Errorf("parseIntStrict(%q): accepted=%v, want accepted=%v", tc.s, err == nil, tc.want)
		}
	}
}

// crAndBOMDoNotAppearAfterSerialize is a light sanity check that
// Serialize never itself emits the bytes these fixes make Parse more
// tolerant of receiving — tolerance on read is not license to relax
// on write.
func TestSerializeNeverEmitsBOMOrLoneCR(t *testing.T) {
	g := Graph{
		Version: "1.2.3",
		Maps: []NamedMap{{
			Path:  "/",
			Boxes: []Box{{ID: "b1", Label: "a\rb"}},
		}},
	}
	out := Serialize(g)
	if strings.Contains(out, "\uFEFF") {
		t.Error("Serialize emitted a BOM")
	}
	if strings.ContainsRune(out, '\r') {
		t.Error("Serialize emitted a raw CR")
	}
}
