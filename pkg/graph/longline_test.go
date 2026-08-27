package graph

import (
	"fmt"
	"strings"
	"testing"
)

// bufio.Scanner defaults to a 64KiB max token (line) size unless
// Buffer() raises it. A single `stroke` directive with enough
// freehand points — completely realistic, not crafted — clears that
// in one line, so Parse used to fail on ordinary large drawings. Two
// separate problems: the failure carried no line number, and the
// graph returned alongside the error was a silent partial parse
// (everything up to the oversized line kept), not an empty one.
// src/graph/parse.ts has no such limit at all (it works over the
// whole string, not line-buffered), so this also used to be a
// Go/TS parity break: the same file opened in the browser and failed
// in the Go binary.

// buildLongStroke returns a `stroke` directive whose serialized line
// exceeds n bytes, by emitting enough "x,y" points.
func buildLongStroke(id string, minBytes int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "stroke %s", id)
	for b.Len() < minBytes {
		b.WriteString(" 12345.6789,98765.4321")
	}
	return b.String()
}

// TestParseLineOverOldSixtyFourKiBLimit pins the regression directly:
// a stroke line comfortably past the old 64KiB bufio.Scanner default
// must parse in full, with every point intact, and produce no error.
func TestParseLineOverOldSixtyFourKiBLimit(t *testing.T) {
	line := buildLongStroke("s1", 200*1024) // ~200KiB, ~3x the old 64KiB cap
	if len(line) <= 64*1024 {
		t.Fatalf("test line is only %d bytes, need > 64KiB to exercise the bug", len(line))
	}
	src := "node b1 hi 0 0\n" + line + "\n"
	g, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse failed on a %d-byte line: %v", len(line), err)
	}
	if len(g.Maps) != 1 {
		t.Fatalf("expected 1 map, got %d — graph looks truncated: %+v", len(g.Maps), g)
	}
	m := g.Maps[0]
	if len(m.Boxes) != 1 {
		t.Errorf("expected the node before the long line to survive, got %d boxes", len(m.Boxes))
	}
	if len(m.Strokes) != 1 {
		t.Fatalf("expected 1 stroke, got %d — the long line was dropped", len(m.Strokes))
	}
	wantPoints := strings.Count(line, ",")
	if got := len(m.Strokes[0].Points); got != wantPoints {
		t.Errorf("stroke has %d points, want %d — points after the old 64KiB cutoff were lost", got, wantPoints)
	}
}

// TestParseLineOverOldLimitRoundTrips closes the loop: Serialize what
// Parse produced from the long line and make sure it parses back
// identically, matching the same round-trip guarantee every other
// directive gets.
func TestParseLineOverOldLimitRoundTrips(t *testing.T) {
	line := buildLongStroke("s1", 150*1024)
	g, err := Parse(line + "\n")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	out := Serialize(g)
	back, err := Parse(out)
	if err != nil {
		t.Fatalf("re-parse of serialized long stroke: %v", err)
	}
	if len(back.Maps[0].Strokes) != 1 || len(back.Maps[0].Strokes[0].Points) != len(g.Maps[0].Strokes[0].Points) {
		t.Fatalf("round-trip lost points: got %+v, want %+v", back.Maps[0].Strokes, g.Maps[0].Strokes)
	}
}

// TestParseTrulyOversizedLineFailsAtomically checks the fallback for
// when a line manages to exceed even the raised ceiling: Parse must
// return a zero-value Graph (no silent partial parse) and an error
// naming the line number, never a graph with everything before the
// bad line kept and no way to know where it broke.
func TestParseTrulyOversizedLineFailsAtomically(t *testing.T) {
	// Comfortably past the 10MiB ceiling Parse now configures.
	line := buildLongStroke("s1", 11*1024*1024)
	src := "node b1 hi 0 0\nnode b2 hi 0 0\n" + line + "\n"
	g, err := Parse(src)
	if err == nil {
		t.Fatalf("expected an error for an oversized line, got a graph with %d maps", len(g.Maps))
	}
	if !strings.Contains(err.Error(), "line 3") {
		t.Errorf("error should name the failing line (3), got: %v", err)
	}
	if len(g.Maps) != 0 {
		t.Errorf("expected an atomic failure (zero-value Graph), got a partial graph: %+v", g)
	}
}
