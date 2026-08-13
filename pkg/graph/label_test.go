package graph

import (
	"strings"
	"testing"
)

// NormalizeLabel mirrors normalizeLabel() in src/graph/label.ts, and
// the two must never drift: a label the editor accepts has to survive
// an MCP round-trip byte-identically, or agents and humans see
// different text. The cases here are the TS suite's, ported — if one
// side gains a case, port it to the other.
func TestNormalizeLabelMirrorsTheEditor(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"empty stays empty", "", ""},
		{"trims leading and trailing whitespace", "   hello   ", "hello"},
		{"collapses internal runs to one space", "a   b\tc", "a b c"},
		{"preserves explicit newlines", "first\nsecond", "first\nsecond"},
		{"trims per line, keeps interior blank lines", "  a  \n\n  b  ", "a\n\nb"},
		{"drops fully-blank leading and trailing lines", "\n\nhi\n\n", "hi"},
		{"whitespace-only collapses to empty", " \t \n \t ", ""},
		{"CRLF and CR both normalize to LF", "a\r\nb\rc", "a\nb\nc"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := NormalizeLabel(c.in); got != c.want {
				t.Fatalf("NormalizeLabel(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestNormalizeLabelCapsOnRuneBoundary(t *testing.T) {
	// The cap must count runes, not bytes: a multi-byte codepoint
	// sliced in half is invalid UTF-8, which the line-based .flowgo
	// serializer would then write out corrupted.
	long := strings.Repeat("ü", MaxLabelLen+50)
	got := NormalizeLabel(long)
	if n := len([]rune(got)); n != MaxLabelLen {
		t.Fatalf("capped length = %d runes, want %d", n, MaxLabelLen)
	}
	if !strings.HasSuffix(got, "ü") {
		t.Fatalf("cap split a multi-byte rune: label ends in %q", got[len(got)-4:])
	}

	exact := strings.Repeat("x", MaxLabelLen)
	if got := NormalizeLabel(exact); got != exact {
		t.Fatalf("a label exactly at the cap must pass through unchanged")
	}
}
