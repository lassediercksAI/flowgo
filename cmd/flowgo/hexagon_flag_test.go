package main

import (
	"strings"
	"testing"

	"github.com/lassediercks/flowgo/pkg/flowgo"
)

// `flowgo --hexagon` seeds the FILE's default shape (defaultshape 1)
// instead of injecting a browser flag — the seeding logic lives in
// main() and is exercised end-to-end by the format tests; here we
// keep the bundle-marker guard the old injection tests carried.

func TestEmbeddedBundleHasHeadMarker(t *testing.T) {
	// Guards the injection point against a bundler change that drops
	// or rewrites </head> — the fallback still works, but we want to
	// know when the primary path stops matching.
	if !strings.Contains(flowgo.IndexHTML, "</head>") {
		t.Fatal("embedded editor bundle has no </head> marker")
	}
}

// --preset seeding: every embedded preset must parse and re-serialize
// with the running version stamped; unknown names error.
func TestPresetSeedAllEmbedded(t *testing.T) {
	names := flowgo.PresetNames()
	if len(names) == 0 {
		t.Fatal("no embedded presets found")
	}
	for _, name := range names {
		out, err := presetSeed(name, "9.9.9")
		if err != nil {
			t.Fatalf("preset %s: %v", name, err)
		}
		if !strings.HasPrefix(out, "version 9.9.9\n") {
			t.Fatalf("preset %s: version not stamped:\n%s", name, out[:60])
		}
	}
}

func TestPresetSeedUnknown(t *testing.T) {
	if _, err := presetSeed("nope", "1.0.0"); err == nil {
		t.Fatal("unknown preset must error")
	}
}

func TestPresetEstuaryKeepsHexagons(t *testing.T) {
	// The estuary preset declares the legacy `hexagons on`; seeding
	// must carry the preference through the parse/stamp/serialize
	// round-trip — re-emitted in its modern form, `defaultshape 1`.
	out, err := presetSeed("estuary-mapping", "1.0.0")
	if err != nil {
		t.Fatalf("presetSeed: %v", err)
	}
	if !strings.Contains(out, "defaultshape 1\n") {
		t.Fatalf("hexagon default lost (expected defaultshape 1):\n%s", out)
	}
	if strings.Contains(out, "hexagons") {
		t.Fatalf("legacy hexagons directive must not be re-emitted:\n%s", out)
	}
}
