package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Opening a legacy-format file rewrites it to the canonical form once
// (box→node spellings, hexagons→defaultshape) with a fresh version
// stamp; already-canonical and unparseable files are left untouched.
func TestMigrateFileToCurrentFormat(t *testing.T) {
	dir := t.TempDir()

	t.Run("legacy directives migrate to node forms", func(t *testing.T) {
		p := filepath.Join(dir, "legacy.flowgo")
		legacy := "version v0.1.8\nhexagons on\nbox b1 Hi 0 0\nbox b2 Two 10 20\nboxsize b2 100 50\nboxshape b1 1\n"
		if err := os.WriteFile(p, []byte(legacy), 0644); err != nil {
			t.Fatal(err)
		}
		migrated, err := migrateFileToCurrentFormat(p)
		if err != nil {
			t.Fatalf("migrate: %v", err)
		}
		if !migrated {
			t.Fatal("expected a migration rewrite")
		}
		out, _ := os.ReadFile(p)
		text := string(out)
		for _, want := range []string{"defaultshape 1\n", "node b1 Hi 0 0\n", "nodesize b2 100 50\n", "nodeshape b1 1\n"} {
			if !strings.Contains(text, want) {
				t.Errorf("migrated file missing %q:\n%s", want, text)
			}
		}
		for _, stale := range []string{"hexagons", "\nbox ", "boxsize", "boxshape"} {
			if strings.Contains(text, stale) {
				t.Errorf("migrated file still contains %q:\n%s", stale, text)
			}
		}
		// Second open is a no-op: the file is now canonical.
		again, err := migrateFileToCurrentFormat(p)
		if err != nil {
			t.Fatalf("second migrate: %v", err)
		}
		if again {
			t.Error("second open must not rewrite again")
		}
	})

	t.Run("unparseable files are left byte-for-byte untouched", func(t *testing.T) {
		p := filepath.Join(dir, "broken.flowgo")
		broken := "version v9\nfrobnicate b1\n"
		if err := os.WriteFile(p, []byte(broken), 0644); err != nil {
			t.Fatal(err)
		}
		migrated, err := migrateFileToCurrentFormat(p)
		if err == nil {
			t.Fatal("expected parse error")
		}
		if migrated {
			t.Fatal("must not report a rewrite on error")
		}
		out, _ := os.ReadFile(p)
		if string(out) != broken {
			t.Errorf("broken file was modified:\n%s", out)
		}
	})
}
