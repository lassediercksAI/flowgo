package flowgo

import (
	"sort"
	"strings"
	"testing"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// The preset API is what `flowgo <name> --preset <preset>` and the
// help output consume; the embedded files' parseability is asserted
// elsewhere against the presets/ directory directly, but nothing
// exercised the lookup functions themselves.

func TestPresetNamesListsEveryEmbeddedPresetSorted(t *testing.T) {
	names := PresetNames()
	if len(names) == 0 {
		t.Fatal("no presets embedded — the presets/ directory should not be empty")
	}
	if !sort.StringsAreSorted(names) {
		t.Fatalf("names not sorted (help output relies on stable order): %v", names)
	}
	for _, n := range names {
		if strings.HasSuffix(n, ".flowgo") {
			t.Fatalf("name %q kept its file suffix — help would print it", n)
		}
	}
}

func TestPresetRoundTripsEveryName(t *testing.T) {
	for _, name := range PresetNames() {
		text, ok := Preset(name)
		if !ok {
			t.Fatalf("Preset(%q) = not found for a name PresetNames listed", name)
		}
		if _, err := graph.Parse(text); err != nil {
			t.Fatalf("embedded preset %q does not parse: %v", name, err)
		}
	}
}

func TestPresetUnknownNameReportsFalse(t *testing.T) {
	if text, ok := Preset("no-such-preset"); ok || text != "" {
		t.Fatalf("Preset(no-such-preset) = (%q, %v), want (\"\", false)", text, ok)
	}
	// Path traversal must not escape the embedded directory.
	if _, ok := Preset("../presets/architecture"); ok {
		t.Fatal("Preset resolved a path-traversal name")
	}
}
