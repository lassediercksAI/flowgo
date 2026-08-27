package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

// A minimal SVG carrying a script, the payload the upload endpoint
// must never accept: SVG is an active document (it can execute
// script), not a picture, and this server has no sanitizer that would
// make storing and re-serving one safe.
var svgWithScript = []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>`)

// TestMediaUploadRejectsSVG covers item #2 of the stored-XSS report:
// SVG uploads must be refused outright, regardless of how earnestly
// the client declares image/svg+xml.
func TestMediaUploadRejectsSVG(t *testing.T) {
	withTempMap(t)
	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(svgWithScript))
	req.Header.Set("Content-Type", "image/svg+xml")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415; body = %s", rec.Code, rec.Body.String())
	}
	entries, _ := os.ReadDir(mediaDir())
	if len(entries) != 0 {
		t.Fatalf("SVG was written to disk: %v", entries)
	}
}

// TestMediaGetNeverServesSVG covers the legacy-file edge of the same
// report item: even if an .svg somehow already exists in the media
// folder (a file planted before this server started rejecting SVG
// uploads, or dropped there some other way), handleMediaGet must
// refuse to serve it rather than falling back to net/http's own
// extension-based Content-Type guess (which would resolve .svg to
// image/svg+xml and reintroduce the exact bug this closes).
func TestMediaGetNeverServesSVG(t *testing.T) {
	withTempMap(t)
	os.MkdirAll(mediaDir(), 0755)
	if err := os.WriteFile(filepath.Join(mediaDir(), "legacy.svg"), svgWithScript, 0644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/"+mediaDirName+"/legacy.svg", nil)
	rec := httptest.NewRecorder()
	handleMediaGet(rec, req)
	if rec.Code == 200 {
		t.Fatalf("legacy .svg was served: status 200, content-type %q, body %s",
			rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

// TestMediaUploadRejectsMismatchedContentType covers item #3 of the
// report: the server must classify an upload by its actual (sniffed)
// bytes, not the client's declared Content-Type. A request that lies
// about its payload — claiming image/png while sending HTML/script —
// must be rejected rather than trustingly stored and later served
// back as image/png (which a browser would still refuse to execute,
// but accepting arbitrary bytes under a false image label is exactly
// the gap a future code path could turn into something worse).
func TestMediaUploadRejectsMismatchedContentType(t *testing.T) {
	withTempMap(t)
	lying := []byte("<html><body><script>alert(1)</script></body></html>")
	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(lying))
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415; body = %s", rec.Code, rec.Body.String())
	}
	entries, _ := os.ReadDir(mediaDir())
	if len(entries) != 0 {
		t.Fatalf("mismatched upload was written to disk: %v", entries)
	}
}

// TestMediaUploadAcceptsGenuineTypes is the positive counterpart to
// the sniffing tests above: real image bytes under their true
// Content-Type must still go through, for every type the product
// accepts other than SVG.
func TestMediaUploadAcceptsGenuineTypes(t *testing.T) {
	// Tiny valid samples of each remaining accepted format.
	gif := []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x00\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b")
	webp := []byte("RIFF\x24\x00\x00\x00WEBPVP8 \x18\x00\x00\x00\x30\x01\x00\x9d\x01\x2a\x01\x00\x01\x00\x02\x00\x34\x25\xa4\x00\x03\x70\x00\xfe\xfb\xfd\x50\x00")
	for _, tc := range []struct {
		name string
		ct   string
		data []byte
	}{
		{"png", "image/png", tinyPNG},
		{"gif", "image/gif", gif},
		{"webp", "image/webp", webp},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withTempMap(t)
			req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(tc.data))
			req.Header.Set("Content-Type", tc.ct)
			rec := httptest.NewRecorder()
			handleMediaUpload(rec, req)
			if rec.Code != 200 {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestMediaUploadContentAddressUsesFullDigest covers item #4: the
// on-disk name must no longer be truncated to a 64-bit prefix of the
// content hash. sha256 hex-encodes to 64 chars; the name (minus
// extension) must be all 64, not the old 16.
func TestMediaUploadContentAddressUsesFullDigest(t *testing.T) {
	withTempMap(t)
	req := httptest.NewRequest(http.MethodPost, "/media", bytes.NewReader(tinyPNG))
	req.Header.Set("Content-Type", "image/png")
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	var resp struct {
		Src string `json:"src"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	base := filepath.Base(resp.Src)
	name := strings.TrimSuffix(base, filepath.Ext(base))
	if len(name) != 64 {
		t.Fatalf("content-address hash is %d hex chars (%q), want 64 (full sha256)", len(name), name)
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
