package main

import (
	"net"
	"testing"
)

// TestListenFirstFree_WalksPastBusyPort holds a port via the OS, then
// asks the helper to walk a small window starting at that exact port.
// The helper must skip the busy seat and return a strictly later port
// inside the requested window. This is the property `--host` relies on
// when a second flowgo (or any unrelated process) already owns 54041.
func TestListenFirstFree_WalksPastBusyPort(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("seed listen: %v", err)
	}
	defer busy.Close()
	port := busy.Addr().(*net.TCPAddr).Port

	ln, err := listenFirstFree("127.0.0.1", port, port+16)
	if err != nil {
		t.Fatalf("listenFirstFree: %v", err)
	}
	defer ln.Close()

	got := ln.Addr().(*net.TCPAddr).Port
	if got == port {
		t.Fatalf("listenFirstFree returned the busy port %d", got)
	}
	if got <= port || got > port+16 {
		t.Fatalf("listenFirstFree out of range: got %d, want in (%d,%d]", got, port, port+16)
	}
}
