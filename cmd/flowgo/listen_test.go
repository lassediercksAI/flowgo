package main

import (
	"fmt"
	"math/rand/v2"
	"net"
	"testing"
)

// walkWindow is the headroom the walk tests ask for above the busy port.
const walkWindow = 16

// reserveBusyPort binds a port that is deliberately chosen to leave
// walkWindow ports of headroom below the 65535 ceiling, and returns it
// held open.
//
// It does NOT use net.Listen("127.0.0.1:0"): asking the OS for an
// ephemeral port means accepting whatever it hands out, and the default
// ephemeral ranges (32768-60999 on Linux, 49152-65535 on macOS) reach
// the top of the port space. A seed port of, say, 65530 leaves nowhere
// for the walk to go, which is exactly how this test flaked (brain#24b).
// Picking from 20000-32000 keeps the whole window well under the ceiling
// and below both ephemeral ranges, so transient sockets are unlikely to
// be squatting on it. A port may still be taken by something else, hence
// the retry.
func reserveBusyPort(t *testing.T) (net.Listener, int) {
	t.Helper()
	const lo, hi = 20000, 32000
	for attempt := 0; attempt < 64; attempt++ {
		port := lo + rand.IntN(hi-lo)
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue // someone else owns it; try another seat
		}
		return ln, port
	}
	t.Fatalf("no free port found in %d-%d after 64 attempts", lo, hi)
	return nil, 0
}

// TestListenFirstFree_WalksPastBusyPort holds a port, then asks the
// helper to walk a small window starting at that exact port. The helper
// must skip the busy seat and return a strictly later port inside the
// requested window. This is the property `--host` relies on when a
// second flowgo (or any unrelated process) already owns 54041.
func TestListenFirstFree_WalksPastBusyPort(t *testing.T) {
	busy, port := reserveBusyPort(t)
	defer busy.Close()

	ln, err := listenFirstFree("127.0.0.1", port, port+walkWindow)
	if err != nil {
		t.Fatalf("listenFirstFree: %v", err)
	}
	defer ln.Close()

	got := ln.Addr().(*net.TCPAddr).Port
	if got == port {
		t.Fatalf("listenFirstFree returned the busy port %d", got)
	}
	if got <= port || got > port+walkWindow {
		t.Fatalf("listenFirstFree out of range: got %d, want in (%d,%d]", got, port, port+walkWindow)
	}
}

// TestListenFirstFree_RejectsRangeAbovePortCeiling constructs the
// near-65535 case deterministically instead of waiting for the OS to
// hand it over. A window that runs off the end of the port space is a
// caller bug, and the helper must say so rather than reporting the
// kernel's complaint about a port number that never existed.
func TestListenFirstFree_RejectsRangeAbovePortCeiling(t *testing.T) {
	for _, tc := range []struct{ start, end int }{
		{65535, 65535 + walkWindow}, // busy port at the very ceiling
		{65530, 65530 + walkWindow}, // the observed flake shape
		{70000, 70016},
	} {
		ln, err := listenFirstFree("127.0.0.1", tc.start, tc.end)
		if ln != nil {
			got := ln.Addr().(*net.TCPAddr).Port
			ln.Close()
			t.Fatalf("listenFirstFree(%d,%d) bound port %d, want no listener", tc.start, tc.end, got)
		}
		if err == nil {
			t.Fatalf("listenFirstFree(%d,%d) returned no error", tc.start, tc.end)
		}
	}
}

// TestListenFirstFree_EmptyRangeErrors pins the nil-listener/nil-error
// case. Returning both nil made every caller nil-dereference on
// ln.Addr() instead of reporting a bad range.
func TestListenFirstFree_EmptyRangeErrors(t *testing.T) {
	ln, err := listenFirstFree("127.0.0.1", 54099, 54041)
	if ln != nil {
		ln.Close()
		t.Fatal("listenFirstFree returned a listener for an empty range")
	}
	if err == nil {
		t.Fatal("listenFirstFree returned (nil, nil) for an empty range: callers panic on ln.Addr()")
	}
}

// TestListenFirstFree_RejectsPortZero guards the other end of the
// range. Port 0 means "any port" to the kernel, so a range starting at
// 0 used to succeed by binding something entirely outside the window
// the caller asked for.
func TestListenFirstFree_RejectsPortZero(t *testing.T) {
	ln, err := listenFirstFree("127.0.0.1", 0, walkWindow)
	if ln != nil {
		got := ln.Addr().(*net.TCPAddr).Port
		ln.Close()
		t.Fatalf("listenFirstFree(0,%d) bound port %d, want no listener", walkWindow, got)
	}
	if err == nil {
		t.Fatalf("listenFirstFree(0,%d) returned no error", walkWindow)
	}
}

// TestListenFirstFree_ExhaustedRangeErrors covers a valid but fully
// occupied range: every port is ours, so the outcome does not depend on
// what else the machine is running.
func TestListenFirstFree_ExhaustedRangeErrors(t *testing.T) {
	first, port := reserveBusyPort(t)
	defer first.Close()

	second, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port+1))
	if err != nil {
		t.Skipf("neighbour port %d already in use: %v", port+1, err)
	}
	defer second.Close()

	ln, err := listenFirstFree("127.0.0.1", port, port+1)
	if ln != nil {
		ln.Close()
		t.Fatal("listenFirstFree bound a port inside a fully occupied range")
	}
	if err == nil {
		t.Fatal("listenFirstFree returned (nil, nil) for a fully occupied range")
	}
}
