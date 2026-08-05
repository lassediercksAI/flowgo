package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The .flowgo file is the whole document — there is no backup and no
// journal. A graph that serializes to bytes Parse then rejects is
// therefore unrecoverable: every later read fails before it can reach
// the data. These tests pin the two properties that keep that from
// happening.
//
//  1. ValidateWritable rejects anything whose bytes don't survive the
//     round-trip, so no write path can put it on disk.
//  2. Serialize alone still produces re-parseable bytes even for input
//     that skipped (1) — the library is pinned by consumers that never
//     call the validator.

// crFolded is what a carriage return becomes on the way to disk: the
// serializer emits it as the `\n` escape, matching NormalizeLabel.
func crFolded(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

// TestCraftedFieldsCannotBrickTheFile covers the two inputs reported on
// brain#245, which a /save POST could put on disk verbatim: an id whose
// whitespace forged a second directive, and a label whose carriage
// return was emitted raw.
func TestCraftedFieldsCannotBrickTheFile(t *testing.T) {
	cases := []struct {
		name string
		g    Graph
		want string // substring of the expected ValidateWritable message
	}{
		{
			name: "id injects a second directive",
			g: Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{
				{ID: "b1 0 0\npwned", Label: "x"},
			}}}},
			want: "contains a line break",
		},
		{
			name: "label carries a carriage return",
			g: Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{
				{ID: "b1", Label: "a\rb"},
			}}}},
			want: "carriage return",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			errs := ValidateWritable(tc.g)
			if len(errs) == 0 {
				t.Fatalf("ValidateWritable accepted %+v", tc.g)
			}
			if !containsSubstring(errs, tc.want) {
				t.Errorf("no error mentions %q; got %v", tc.want, errs)
			}
			// Validate must reject it too — that's the MCP set_state gate.
			if len(Validate(tc.g)) == 0 {
				t.Error("Validate accepted it")
			}
			// And even unvalidated, the bytes must re-parse.
			if _, err := Parse(Serialize(tc.g)); err != nil {
				t.Errorf("Serialize output no longer parses: %v\nbytes: %q", err, Serialize(tc.g))
			}
		})
	}
}

// TestNastyIDsRejectedButStillSerializable walks the characters that
// carry structure in the text format. Every one of them must be
// refused at the boundary; none of them may produce bytes that lock
// the file.
func TestNastyIDsRejectedButStillSerializable(t *testing.T) {
	nasty := []struct {
		name string
		id   string
	}{
		{"space", "b 1"},
		{"tab", "b\t1"},
		{"newline", "b\n1"},
		{"carriage return", "b\r1"},
		{"crlf", "b\r\n1"},
		{"forged node directive", "b1 0 0\npwned"},
		{"double quote", `b"1`},
		{"backslash", `b\1`},
		{"nul", "b\x001"},
		{"non-breaking space", "b 1"},
		{"line separator", "b 1"},
		{"colon", "b1:t"},
	}
	for _, tc := range nasty {
		t.Run(tc.name, func(t *testing.T) {
			g := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{
				{ID: tc.id, Label: "hello"},
				{ID: "other", Label: "world"},
			}, Edges: []Edge{{From: tc.id, To: "other"}}}}}

			if errs := ValidateWritable(g); len(errs) == 0 {
				t.Fatalf("id %q accepted", tc.id)
			}
			// The edge endpoint carrying the same id is flagged too, so
			// a graph that only smuggles the id in via an edge can't
			// slip past.
			if errs := ValidateWritable(Graph{Maps: []NamedMap{{
				Path:  "/",
				Boxes: []Box{{ID: "other", Label: "w"}},
				Edges: []Edge{{From: tc.id, To: "other"}},
			}}}); len(errs) == 0 {
				t.Errorf("edge endpoint %q accepted", tc.id)
			}

			// Defense in depth: the file must stay openable regardless.
			if _, err := Parse(Serialize(g)); err != nil {
				t.Errorf("Serialize output no longer parses: %v\nbytes: %q", err, Serialize(g))
			}
		})
	}
}

// TestPlainIDsRoundTripUnchanged is the other half: the accepted set
// has to come back byte-identical, or "reject the weird ones" would
// just be a euphemism for mangling everything.
func TestPlainIDsRoundTripUnchanged(t *testing.T) {
	ok := []string{
		"b1", "t12", "s3", "img1",
		"kebab-case", "snake_case", "dot.separated", "MiXeDcAsE",
		"Ünïcödé", "日本語", "emoji🙂", "b1?query=1", "100%",
	}
	for _, id := range ok {
		t.Run(id, func(t *testing.T) {
			g := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{
				{ID: id, Label: "hello", W: 120, H: 40, Shape: 2, Anchor: true},
				{ID: "peer", Label: "world"},
			}, Edges: []Edge{{From: id, To: "peer", FromHandle: "t"}}}}}
			if errs := ValidateWritable(g); len(errs) > 0 {
				t.Fatalf("id %q rejected: %v", id, errs)
			}
			text := Serialize(g)
			if strings.Contains(text, `"`+id+`"`) {
				t.Errorf("plain id got quoted, changing the on-disk bytes: %q", text)
			}
			back, err := Parse(text)
			if err != nil {
				t.Fatalf("parse: %v\nbytes: %q", err, text)
			}
			b := back.Maps[0].Boxes[0]
			if b.ID != id {
				t.Errorf("id round-tripped as %q, want %q", b.ID, id)
			}
			if b.W != 120 || b.H != 40 || b.Shape != 2 || !b.Anchor {
				t.Errorf("per-id directives lost their target: %+v", b)
			}
			if e := back.Maps[0].Edges[0]; e.From != id || e.FromHandle != "t" {
				t.Errorf("edge endpoint round-tripped as %q/%q, want %q/t", e.From, e.FromHandle, id)
			}
		})
	}
}

// TestNastyLabelsRoundTrip pins the label side. Labels are user text —
// they may contain anything except a carriage return, which is folded
// to a newline because the two parsers cannot agree on a raw CR
// (Go's scanner reads past it, src/graph/parse.ts splits on it).
func TestNastyLabelsRoundTrip(t *testing.T) {
	labels := []string{
		"plain",
		"with space",
		"with\ttab",
		"with\nnewline",
		"with\rcarriage return",
		"with\r\ncrlf",
		`with "quotes"`,
		`with \backslash`,
		`with \"both\"`,
		"trailing backslash \\",
		"Ünïcödé — em dash",
		"日本語のラベル",
		"emoji 🙂🎉",
		"node b2 forged 0 0",
		"\"unbalanced",
		"",
	}
	for _, label := range labels {
		t.Run(label, func(t *testing.T) {
			g := Graph{Maps: []NamedMap{{
				Path:   "/",
				Boxes:  []Box{{ID: "b1", Label: label}},
				Texts:  []Text{{ID: "t1", Label: label}},
				Images: []Image{{ID: "i1", Src: "flowgo-media/x.png", Width: 1, Height: 1}},
			}}}
			text := Serialize(g)
			if strings.ContainsRune(text, '\r') {
				t.Errorf("serializer emitted a raw CR — src/graph/parse.ts would split the directive there: %q", text)
			}
			back, err := Parse(text)
			if err != nil {
				t.Fatalf("parse: %v\nbytes: %q", err, text)
			}
			want := crFolded(label)
			if got := back.Maps[0].Boxes[0].Label; got != want {
				t.Errorf("box label = %q, want %q (bytes %q)", got, want, text)
			}
			if got := back.Maps[0].Texts[0].Label; got != want {
				t.Errorf("text label = %q, want %q (bytes %q)", got, want, text)
			}
			// Only the CR case is a validation error; everything else
			// is legitimate user text that must save.
			errs := ValidateWritable(g)
			if strings.ContainsRune(label, '\r') != (len(errs) > 0) {
				t.Errorf("ValidateWritable disagrees with the CR rule: label %q -> %v", label, errs)
			}
		})
	}
}

// TestEmptyLabelSurvivesRoundTrip pins a third brick found while
// testing the two on the card, and the nastiest of them because it
// needs no crafting at all: a node whose label is empty serializes to
// `node b1 "" 0 0`, and the tokenizer used to drop the empty quoted
// token, leaving a four-token line the parser rejects. Validate passed
// it too, so the MCP set_state path was exposed as well — clearing a
// node's text and saving was enough to lose the document.
func TestEmptyLabelSurvivesRoundTrip(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:  "/",
		Boxes: []Box{{ID: "b1", Label: ""}, {ID: "b2", Label: "kept"}},
		Texts: []Text{{ID: "t1", Label: ""}},
	}}}
	if errs := ValidateWritable(g); len(errs) > 0 {
		t.Fatalf("an empty label is legitimate, but it was rejected: %v", errs)
	}
	back, err := Parse(Serialize(g))
	if err != nil {
		t.Fatalf("parse: %v\nbytes: %q", err, Serialize(g))
	}
	if len(back.Maps[0].Boxes) != 2 || back.Maps[0].Boxes[0].ID != "b1" ||
		back.Maps[0].Boxes[0].Label != "" || back.Maps[0].Boxes[1].Label != "kept" {
		t.Errorf("boxes = %+v", back.Maps[0].Boxes)
	}
	if len(back.Maps[0].Texts) != 1 || back.Maps[0].Texts[0].Label != "" {
		t.Errorf("texts = %+v", back.Maps[0].Texts)
	}
}

// TestEmptyIDStillProducesAReadableFile: an empty id is rejected on
// every write path (nothing can reference it), but Serialize must not
// be the thing that discovers that — an empty node id used to emit
// `node  x 0 0`, one token short, and take the document with it.
func TestEmptyIDStillProducesAReadableFile(t *testing.T) {
	g := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "", Label: "x"}}}}}
	if errs := ValidateWritable(g); len(errs) == 0 {
		t.Error("an empty id should still be refused at the boundary")
	}
	back, err := Parse(Serialize(g))
	if err != nil {
		t.Fatalf("parse: %v\nbytes: %q", err, Serialize(g))
	}
	if len(back.Maps[0].Boxes) != 1 || back.Maps[0].Boxes[0].Label != "x" {
		t.Errorf("boxes = %+v", back.Maps[0].Boxes)
	}
}

// TestQuotedEmptyLeadingTokenStaysIgnored guards the tolerance the
// tokenize fix could have cost: a line starting with `""` produced no
// tokens before and was skipped, so it must keep being skipped rather
// than becoming an "unknown directive" error in files that open today.
func TestQuotedEmptyLeadingTokenStaysIgnored(t *testing.T) {
	g, err := Parse("node b1 hi 0 0\n\"\"\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(g.Maps[0].Boxes) != 1 {
		t.Errorf("boxes = %+v", g.Maps[0].Boxes)
	}
}

// TestMapPathsCannotForgeDirectives closes the same hole one level up:
// `map <path>` is a directive too, and a path with whitespace either
// truncated silently or injected a line.
func TestMapPathsCannotForgeDirectives(t *testing.T) {
	for _, path := range []string{"/a b", "/a\nnode x y 0 0", "/a\tb", "/a\"b"} {
		t.Run(path, func(t *testing.T) {
			g := Graph{Maps: []NamedMap{
				{Path: "/", Boxes: []Box{{ID: "a", Label: "A"}}},
				{Path: path, Boxes: []Box{{ID: "b1", Label: "x"}}},
			}}
			if errs := ValidateWritable(g); len(errs) == 0 {
				t.Fatalf("path %q accepted", path)
			}
			back, err := Parse(Serialize(g))
			if err != nil {
				t.Fatalf("Serialize output no longer parses: %v\nbytes: %q", err, Serialize(g))
			}
			if len(back.Maps) != 2 || back.Maps[1].Path != path {
				t.Errorf("path did not survive the round-trip: %+v", back.Maps)
			}
		})
	}
}

// TestRealFixturesPassValidateWritable is the compatibility gate: the
// new rule now runs on every save, so any checked-in document it
// rejects would be a document users can no longer write back.
func TestRealFixturesPassValidateWritable(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "flowgo", "presets", "*.flowgo"))
	if err != nil {
		t.Fatal(err)
	}
	paths = append(paths, "map.flowgo")
	if len(paths) < 2 {
		t.Fatalf("expected several fixtures, found %v", paths)
	}
	for _, p := range paths {
		t.Run(filepath.Base(p), func(t *testing.T) {
			data, err := os.ReadFile(p)
			if err != nil {
				t.Fatal(err)
			}
			g, err := Parse(string(data))
			if err != nil {
				t.Fatalf("fixture does not parse: %v", err)
			}
			if errs := ValidateWritable(g); len(errs) > 0 {
				t.Errorf("real fixture rejected by the new write gate: %v", errs)
			}
		})
	}
}

func containsSubstring(errs []error, want string) bool {
	for _, e := range errs {
		if strings.Contains(e.Error(), want) {
			return true
		}
	}
	return false
}
