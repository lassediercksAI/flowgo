package graph

import (
	"strings"
	"testing"
)

// The `version` directive records the flowgo binary that last wrote
// the file. Older flowgo files have no `version` line and must keep
// parsing — Version stays empty in that case.
func TestParseVersionDirective(t *testing.T) {
	cases := []struct {
		name        string
		input       string
		wantVersion string
	}{
		{"absent", "box b1 hi 0 0\n", ""},
		{"present", "version 0.0.23\nbox b1 hi 0 0\n", "0.0.23"},
		{"with leading blank", "\nversion 1.2.3\nbox b1 hi 0 0\n", "1.2.3"},
		// Last occurrence wins so a corrupted leading directive can be
		// repaired by appending a corrected one.
		{"duplicate, last wins", "version 0.0.1\nversion 9.9.9\n", "9.9.9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g, err := Parse(tc.input)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if g.Version != tc.wantVersion {
				t.Fatalf("version: got %q, want %q", g.Version, tc.wantVersion)
			}
		})
	}
}

// `version` on its own (no value) is a parse error — silently dropping
// it would mask a corrupted file from the user.
func TestParseVersionMissingValue(t *testing.T) {
	_, err := Parse("version\n")
	if err == nil {
		t.Fatal("expected error for bare `version` directive")
	}
	if !strings.Contains(err.Error(), "version") {
		t.Fatalf("error should mention version, got: %v", err)
	}
}

// Serializer emits `version <ver>` as the first line when Version is
// set, and emits nothing otherwise. The first-line position matters
// for human readability — a downstream `head -1` should reveal the
// writer's version.
func TestSerializeVersionDirective(t *testing.T) {
	t.Run("omitted when empty", func(t *testing.T) {
		out := Serialize(Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: "hi"}}}}})
		if strings.HasPrefix(out, "version") {
			t.Fatalf("unexpected version line in output:\n%s", out)
		}
	})
	t.Run("first line when set", func(t *testing.T) {
		out := Serialize(Graph{
			Version: "0.0.23",
			Maps:    []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: "hi"}}}},
		})
		if !strings.HasPrefix(out, "version 0.0.23\n") {
			t.Fatalf("expected version line first, got:\n%s", out)
		}
	})
}

// Parse(Serialize(g)) must preserve Version verbatim so consumers can
// trust it as a stable record.
func TestVersionRoundTrip(t *testing.T) {
	for _, v := range []string{"", "0.0.23", "1.2.3-rc.4", "dev"} {
		g := Graph{
			Version: v,
			Maps:    []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: "hi"}}}},
		}
		out, err := Parse(Serialize(g))
		if err != nil {
			t.Fatalf("version %q re-parse: %v", v, err)
		}
		if out.Version != v {
			t.Fatalf("version %q: round-tripped as %q", v, out.Version)
		}
	}
}
