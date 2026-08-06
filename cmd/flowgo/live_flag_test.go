package main

import (
	"strings"
	"testing"
)

// The hosted service embeds the same bundle without this injection;
// that page must not start the live client.
func TestInjectLiveFlag(t *testing.T) {
	in := []byte("<html><head><title>x</title></head><body></body></html>")
	out := injectLiveFlag(in)
	if !strings.Contains(string(out), "window.FLOWGO_LIVE=true") {
		t.Fatal("flag not injected")
	}
	if strings.Index(string(out), "FLOWGO_LIVE") > strings.Index(string(out), "</head>") {
		t.Fatal("flag must be inside head, before the bundle boots")
	}
	if !strings.Contains(string(out), "<title>x</title>") {
		t.Fatal("original content lost")
	}
}

func TestInjectLiveFlagNoMarkerLeavesHTMLUntouched(t *testing.T) {
	in := []byte("<html><body>no head marker</body></html>")
	if string(injectLiveFlag(in)) != string(in) {
		t.Fatal("HTML must be returned untouched when the marker is absent")
	}
}
