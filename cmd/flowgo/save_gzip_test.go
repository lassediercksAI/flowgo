package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

// The gzip stopgap (brain#25c): compressed save bodies decode
// transparently, the byte cap guards the DECOMPRESSED size (a capped
// wire size would still let a small bomb expand into RAM), and the
// capability only matters when advertised — plain saves are untouched.

func gzipped(t *testing.T, s string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := io.WriteString(zw, s); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf
}

func TestSaveBodyReaderGunzips(t *testing.T) {
	doc := `{"maps":[{"path":"/","boxes":[]}]}`
	req := httptest.NewRequest("POST", "/save", gzipped(t, doc))
	req.Header.Set("Content-Encoding", "gzip")
	rec := httptest.NewRecorder()
	rd, err := saveBodyReader(rec, req, maxSaveBytes)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(rd)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != doc {
		t.Fatalf("gunzip round trip: got %q", got)
	}
}

func TestSaveBodyReaderCapsDecompressedBytes(t *testing.T) {
	// A ~40-byte wire body expanding past the limit must be truncated
	// at the limit, so the JSON decode fails instead of the process
	// holding an unbounded document.
	bomb := strings.Repeat("A", 1<<20)
	req := httptest.NewRequest("POST", "/save", gzipped(t, bomb))
	req.Header.Set("Content-Encoding", "gzip")
	rec := httptest.NewRecorder()
	rd, err := saveBodyReader(rec, req, 1024)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rd)
	if len(got) > 1024 {
		t.Fatalf("decompressed read returned %d bytes past the 1024 cap", len(got))
	}
}

func TestSaveBodyReaderPlainPathUnchanged(t *testing.T) {
	doc := `{"maps":[]}`
	req := httptest.NewRequest("POST", "/save", strings.NewReader(doc))
	rec := httptest.NewRecorder()
	rd, err := saveBodyReader(rec, req, maxSaveBytes)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rd)
	if string(got) != doc {
		t.Fatalf("plain body altered: %q", got)
	}
}

func TestSaveBodyReaderRejectsGarbageGzip(t *testing.T) {
	req := httptest.NewRequest("POST", "/save", strings.NewReader("not gzip"))
	req.Header.Set("Content-Encoding", "gzip")
	rec := httptest.NewRecorder()
	if _, err := saveBodyReader(rec, req, maxSaveBytes); err == nil {
		t.Fatal("garbage gzip must error, not decode as JSON noise")
	}
}
