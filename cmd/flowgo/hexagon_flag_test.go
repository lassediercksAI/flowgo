package main

import (
	"strings"
	"testing"

	"github.com/lassediercks/flowgo/pkg/flowgo"
)

// The --hexagon CLI flag injects window.FLOWGO_HEXAGON into the served
// editor page; hex.ts reads it at boot. These tests pin the injection
// point (inside <head>, so it executes before the deferred module
// script) and the no-marker fallback.

func TestInjectHexagonFlagBeforeHead(t *testing.T) {
	in := []byte("<!doctype html><html><head><title>x</title></head><body></body></html>")
	out := string(injectHexagonFlag(in))
	if !strings.Contains(out, "window.FLOWGO_HEXAGON = true") {
		t.Fatalf("flag script missing:\n%s", out)
	}
	if !strings.Contains(out, "window.FLOWGO_HEXAGON = true</script></head>") {
		t.Fatalf("flag script not injected immediately before </head>:\n%s", out)
	}
}

func TestInjectHexagonFlagFallbackWithoutHead(t *testing.T) {
	in := []byte("<div>no head marker</div>")
	out := string(injectHexagonFlag(in))
	if !strings.HasPrefix(out, "<script>window.FLOWGO_HEXAGON = true</script>") {
		t.Fatalf("fallback should prepend the flag script:\n%s", out)
	}
	if !strings.HasSuffix(out, "<div>no head marker</div>") {
		t.Fatalf("original content must be preserved:\n%s", out)
	}
}

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
	// The estuary preset declares `hexagons on`; seeding must carry
	// the document flag through the parse/stamp/serialize round-trip.
	out, err := presetSeed("estuary-mapping", "1.0.0")
	if err != nil {
		t.Fatalf("presetSeed: %v", err)
	}
	if !strings.Contains(out, "hexagons on\n") {
		t.Fatalf("hexagons directive lost:\n%s", out)
	}
}
