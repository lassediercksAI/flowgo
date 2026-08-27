package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A 1x1 transparent PNG, enough bytes to exercise the upload path.
var tinyPNG = []byte{
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
	0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
}

func withTempMap(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	prev := filePath
	filePath = filepath.Join(dir, "test.flowgo")
	t.Cleanup(func() { filePath = prev })
}

func TestMediaUploadWritesContentAddressedFile(t *testing.T) {
	withTempMap(t)

	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(tinyPNG))
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Src string `json:"src"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := filepath.Dir(resp.Src); got != mediaDirName {
		t.Fatalf("src not under %s/: %q", mediaDirName, resp.Src)
	}
	if _, err := os.Stat(filepath.Join(mediaDir(), filepath.Base(resp.Src))); err != nil {
		t.Fatalf("file not written: %v", err)
	}

	// Second identical upload dedups to the same name.
	req2 := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(tinyPNG))
	req2.Header.Set("Content-Type", "image/png")
	rec2 := httptest.NewRecorder()
	handleMediaUpload(rec2, req2)
	var resp2 struct {
		Src string `json:"src"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &resp2)
	if resp2.Src != resp.Src {
		t.Fatalf("dedup failed: %q != %q", resp2.Src, resp.Src)
	}
	entries, _ := os.ReadDir(mediaDir())
	if len(entries) != 1 {
		t.Fatalf("expected 1 file after dedup, got %d", len(entries))
	}
}

func TestMediaUploadRejectsNonImage(t *testing.T) {
	withTempMap(t)
	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader([]byte("nope")))
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", rec.Code)
	}
}

// SVG uploads are rejected outright, regardless of the declared
// Content-Type: a stored SVG carrying a <script> executes in this
// server's origin the moment a browser is pointed at the raw asset
// URL, and there's no sanitizer here that could make that safe.
func TestMediaUploadRejectsSVG(t *testing.T) {
	withTempMap(t)
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"></svg>`)
	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(svg))
	req.Header.Set("Content-Type", "image/svg+xml")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", rec.Code)
	}
	entries, _ := os.ReadDir(mediaDir())
	if len(entries) != 0 {
		t.Fatalf("SVG bytes were written to disk despite rejection: %v", entries)
	}
}

// The upload's stored type is decided by the ACTUAL BYTES, not the
// client's Content-Type header — a client that lies about the header
// to smuggle disallowed content past the map lookup must still be
// rejected (or, for content that happens to sniff as an allowed type
// under a different label, classified by what it really is, not what
// it claims to be).
func TestMediaUploadIgnoresClientClaimedContentType(t *testing.T) {
	withTempMap(t)
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"></svg>`)
	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(svg))
	// Lie: claim this SVG payload is a PNG.
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415 (bytes sniff as non-image regardless of the claimed header)", rec.Code)
	}
	entries, _ := os.ReadDir(mediaDir())
	if len(entries) != 0 {
		t.Fatalf("mislabeled SVG bytes were written to disk: %v", entries)
	}

	// The converse: real PNG bytes under a wrong/absent header are
	// still accepted and stored as a PNG, sniffed from the bytes.
	req2 := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(tinyPNG))
	req2.Header.Set("Content-Type", "application/octet-stream")
	rec2 := httptest.NewRecorder()
	handleMediaUpload(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("real PNG bytes under a generic Content-Type: status = %d, body = %s", rec2.Code, rec2.Body.String())
	}
	var resp struct {
		Src string `json:"src"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if filepath.Ext(resp.Src) != ".png" {
		t.Fatalf("sniffed PNG stored under wrong extension: %q", resp.Src)
	}
}

func TestMediaGetRoundTrip(t *testing.T) {
	withTempMap(t)
	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(tinyPNG))
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	var resp struct {
		Src string `json:"src"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)

	getReq := httptest.NewRequest(http.MethodGet, "/"+resp.Src, nil)
	getRec := httptest.NewRecorder()
	handleMediaGet(getRec, getReq)
	if getRec.Code != 200 {
		t.Fatalf("get status = %d", getRec.Code)
	}
	if ct := getRec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %q", ct)
	}
	if !bytes.Equal(getRec.Body.Bytes(), tinyPNG) {
		t.Fatal("served bytes differ from uploaded")
	}
}

func TestMediaGetRejectsTraversal(t *testing.T) {
	withTempMap(t)
	// Plant a secret next to the media dir to prove it can't be reached.
	os.MkdirAll(mediaDir(), 0755)
	secret := filepath.Join(filepath.Dir(filePath), "secret.txt")
	os.WriteFile(secret, []byte("top secret"), 0644)

	for _, p := range []string{
		"/" + mediaDirName + "/../secret.txt",
		"/" + mediaDirName + "/..%2fsecret.txt",
		"/" + mediaDirName + "/sub/evil.png",
	} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		handleMediaGet(rec, req)
		if rec.Code == 200 && bytes.Contains(rec.Body.Bytes(), []byte("top secret")) {
			t.Fatalf("traversal leaked secret via %q", p)
		}
	}
}
