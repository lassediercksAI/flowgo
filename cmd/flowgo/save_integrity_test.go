package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/lassediercks/flowgo/pkg/flowgo"
)

// TestSaveRejectsCraftedPayloadsAndStateKeepsWorking replays brain#245
// step by step against the real handlers:
//
//  1. serve a .flowgo file
//  2. POST the crafted payload to /save
//  3. GET /state
//
// Before the fix, step 2 answered 204 and step 3 answered 500 with
// `line 1: node needs id label x y` — permanently, because the crafted
// bytes were now the file. Now step 2 answers 400 and step 3 keeps
// serving the untouched document.
func TestSaveRejectsCraftedPayloadsAndStateKeepsWorking(t *testing.T) {
	const original = "version 0.0.1\nnode b1 hello 0 0\nnode b2 \"two words\" 100 0\n\nedge b1 b2\n"

	payloads := map[string]string{
		// Card repro step 2, byte for byte.
		"id injection": `{"maps":[{"path":"/","boxes":[{"id":"b1 0 0\npwned","label":"x","x":0,"y":0}]}]}`,
		// Card repro step 4.
		"carriage return in label": `{"maps":[{"path":"/","boxes":[{"id":"b1","label":"a\rb","x":0,"y":0}]}]}`,
		"quote in id":              `{"maps":[{"path":"/","boxes":[{"id":"b\"1","label":"x","x":0,"y":0}]}]}`,
		"backslash in id":          `{"maps":[{"path":"/","boxes":[{"id":"b\\1","label":"x","x":0,"y":0}]}]}`,
		"newline in map path":      `{"maps":[{"path":"/a\nnode evil x 0 0","boxes":[{"id":"b1","label":"x","x":0,"y":0}]}]}`,
	}

	for name, body := range payloads {
		t.Run(name, func(t *testing.T) {
			path := serveTempMap(t, original)

			rec := httptest.NewRecorder()
			handleSave(rec, httptest.NewRequest(http.MethodPost, "/save", bytes.NewReader([]byte(body))))
			if rec.Code != 400 {
				t.Fatalf("/save status = %d (want 400), body = %s\nfile is now %q",
					rec.Code, rec.Body.String(), mustReadFile(t, path))
			}

			if got := mustReadFile(t, path); got != original {
				t.Errorf("rejected save modified the file:\n got:  %q\n want: %q", got, original)
			}

			stateRec := httptest.NewRecorder()
			handleState(stateRec, httptest.NewRequest(http.MethodGet, "/state", nil))
			if stateRec.Code != 200 {
				t.Fatalf("/state status = %d, body = %s", stateRec.Code, stateRec.Body.String())
			}
			var got struct {
				Maps []struct {
					Boxes []struct{ ID string } `json:"boxes"`
				} `json:"maps"`
			}
			if err := json.Unmarshal(stateRec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode /state: %v", err)
			}
			if len(got.Maps) != 1 || len(got.Maps[0].Boxes) != 2 {
				t.Errorf("/state no longer serves the original document: %s", stateRec.Body.String())
			}
		})
	}
}

// A well-formed save must still work end to end — including the empty
// label that used to brick the file on its own.
func TestSaveAcceptsOrdinaryPayloads(t *testing.T) {
	for name, body := range map[string]string{
		"normal":       `{"maps":[{"path":"/","boxes":[{"id":"b1","label":"hello","x":0,"y":0}]}]}`,
		"empty label":  `{"maps":[{"path":"/","boxes":[{"id":"b1","label":"","x":0,"y":0}]}]}`,
		"multi-line":   `{"maps":[{"path":"/","boxes":[{"id":"b1","label":"two\nlines","x":0,"y":0}]}]}`,
		"quoted label": `{"maps":[{"path":"/","boxes":[{"id":"b1","label":"say \"hi\"","x":0,"y":0}]}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			serveTempMap(t, "node old x 0 0\n")
			rec := httptest.NewRecorder()
			handleSave(rec, httptest.NewRequest(http.MethodPost, "/save", bytes.NewReader([]byte(body))))
			if rec.Code != 204 {
				t.Fatalf("/save status = %d, body = %s", rec.Code, rec.Body.String())
			}
			stateRec := httptest.NewRecorder()
			handleState(stateRec, httptest.NewRequest(http.MethodGet, "/state", nil))
			if stateRec.Code != 200 {
				t.Fatalf("/state status = %d, body = %s", stateRec.Code, stateRec.Body.String())
			}
		})
	}
}

// serveTempMap seeds a .flowgo file and configures pkg/flowgo for it,
// the way main() does for `flowgo <file>`.
func serveTempMap(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.flowgo")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	prev := filePath
	filePath = path
	var mu sync.Mutex
	flowgo.Configure(flowgo.Config{
		ServeMode:   false,
		LocalFile:   path,
		LocalFileMu: &mu,
		Version:     resolveVersionString,
	})
	t.Cleanup(func() { filePath = prev })
	return path
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}
