package graph

import (
	"bytes"
	"fmt"
	"math"
	"math/rand"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestNumberFormatMatchesUnitTable pins jsNumberString against a fixed
// table with no external dependency, so the common cases fail fast
// even where `node` isn't on PATH. Includes the case that motivated
// this whole file: Go's old `%g` formatter switched to scientific
// notation at exponent >= 6, so Serialize wrote 1000000 (the editor's
// own MAX_TRANSLATE — reachable by dragging a node to the canvas
// edge, no crafted file needed) as "1e+06" while the TS serializer
// (String(n)) wrote "1000000". Same Graph, different bytes.
func TestNumberFormatMatchesUnitTable(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{math.Copysign(0, -1), "0"}, // -0 folds to "0", matching (-0).toString()
		{1, "1"},
		{-1, "-1"},
		{100, "100"},
		{999999, "999999"},
		{1000000, "1000000"},   // the regression: used to be "1e+06"
		{-1000000, "-1000000"}, // MAX_TRANSLATE's negative counterpart
		{1000001, "1000001"},
		{0.1, "0.1"},
		{100.5, "100.5"},
		{0.0001, "0.0001"},
		{0.00001, "0.00001"},
		{0.000001, "0.000001"},
		{0.0000001, "1e-7"}, // JS's -6 < n <= 0 threshold
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"}, // JS's plain-vs-scientific threshold, unlike Go's %g
		{1.5e21, "1.5e+21"},
		{9007199254740991, "9007199254740991"}, // Number.MAX_SAFE_INTEGER
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%v", tc.in), func(t *testing.T) {
			if got := jsNumberString(tc.in); got != tc.want {
				t.Errorf("jsNumberString(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestNumberFormatMatchesRealJS is the CROSS-IMPLEMENTATION PARITY
// TEST: it shells out to a real `node` binary (scripts/js-num-
// format.mjs) and checks that jsNumberString agrees with it for a
// representative spread of values — negatives, zero, MAX_TRANSLATE
// (1,000,000, editor-reachable), values straddling both languages'
// scientific-notation thresholds, fractional values, and a batch of
// deterministic pseudo-random floats across a wide magnitude range.
//
// Skips (rather than fails) when `node` isn't on PATH, so `go test`
// still works in a Go-only environment; CI's `validate` job installs
// both toolchains (see .github/workflows/ci.yml), so it always runs
// there.
func TestNumberFormatMatchesRealJS(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH; skipping Go/JS cross-implementation parity check")
	}
	scriptPath, err := filepath.Abs(filepath.Join("..", "..", "scripts", "js-num-format.mjs"))
	if err != nil {
		t.Fatal(err)
	}

	values := []float64{
		0, math.Copysign(0, -1), 1, -1, 0.5, -0.5, 42, -42, 100, 250000,
		999999, 1000000, -1000000, 1000001, 1234567.891, 12345.6789, -12345.6789,
		0.1, 0.001, 0.0001, 0.00001, 0.000001, 0.0000001, 0.00000001,
		1e15, 1e18, 1e20, 1e21, 1e21 + 2e5, 1.5e21, 1e22, 1e30,
		123456789012345680000, 9007199254740991, 9007199254740992,
		3.14159265358979, 100.25, -100.25,
	}
	// Deterministic fuzz: fixed seed so failures reproduce.
	rng := rand.New(rand.NewSource(20260827))
	for i := 0; i < 500; i++ {
		mag := rng.Float64()*40 - 15 // 10^-15 .. 10^25ish
		v := rng.Float64() * math.Pow(10, mag)
		if rng.Intn(2) == 0 {
			v = -v
		}
		values = append(values, v)
	}

	var stdin bytes.Buffer
	for _, v := range values {
		// Shortest round-trip decimal encoding as the transport: Node's
		// Number() parser is correctly-rounded, so parsing this string
		// reconstructs exactly v, and neither the bug under test (Go's
		// %g threshold) nor any other formatting quirk leaks into what
		// we're sending — only jsNumberString's *output* is compared.
		fmt.Fprintln(&stdin, strconv.FormatFloat(v, 'e', -1, 64))
	}

	cmd := exec.Command(nodePath, scriptPath)
	cmd.Stdin = &stdin
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("node %s failed: %v\nstderr: %s", scriptPath, err, stderr.String())
	}

	got := strings.Split(strings.TrimRight(stdout.String(), "\n"), "\n")
	if len(got) != len(values) {
		t.Fatalf("node produced %d lines, want %d", len(got), len(values))
	}

	mismatches := 0
	for i, v := range values {
		want := got[i]
		have := jsNumberString(v)
		if have != want {
			mismatches++
			if mismatches <= 20 {
				t.Errorf("jsNumberString(%v) = %q, real JS String(%v) = %q", v, have, v, want)
			}
		}
	}
	if mismatches > 20 {
		t.Errorf("... and %d more mismatches", mismatches-20)
	}
}

// TestSerializeUsesJSNumberFormat checks the parity fix at the level
// Serialize actually emits it, not just the helper function: a Box at
// the editor's MAX_TRANSLATE must produce the same bytes an
// unquoted-number TS `flowgoNum` (String(n)) would.
func TestSerializeUsesJSNumberFormat(t *testing.T) {
	g := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{
		{ID: "b1", Label: "x", X: 1000000, Y: -1000000},
	}}}}
	out := Serialize(g)
	want := "node b1 x 1000000 -1000000\n"
	if out != want {
		t.Errorf("Serialize at MAX_TRANSLATE = %q, want %q", out, want)
	}
}
