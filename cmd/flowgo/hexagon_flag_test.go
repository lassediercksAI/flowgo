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
