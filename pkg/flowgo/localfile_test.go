package flowgo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// realFixtures returns every checked-in .flowgo file (the pkg/graph
// round-trip fixture plus the embedded presets) as name → content.
// Parity tests run against THESE, not synthetic data: the fixtures
// exercise the format's real corner cases (quoting, shapes, strokes,
// legacy spellings).
func realFixtures(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	read := func(path string) {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read fixture %s: %v", path, err)
		}
		out[filepath.Base(path)] = string(data)
	}
	read(filepath.Join("..", "graph", "map.flowgo"))
	entries, err := os.ReadDir("presets")
	if err != nil {
		t.Fatalf("read presets dir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".flowgo") {
			read(filepath.Join("presets", e.Name()))
		}
	}
	if len(out) < 2 {
		t.Fatalf("expected multiple fixtures, got %d", len(out))
	}
	return out
}

func configureLocalFile(t *testing.T, content string) string {
	t.Helper()
	orig := cfg
	t.Cleanup(func() { Configure(orig) })
	path := filepath.Join(t.TempDir(), "map.flowgo")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	Configure(Config{LocalFile: path})
	return path
}

// TestLocalWriteByteParityWithLegacyWriter proves the new write path
// produces byte-for-byte what the old os.WriteFile-based path wrote:
// for every real fixture, a no-op MCP mutation and an editor /save
// both leave exactly serialize(parse(fixture)) with the version
// stamped — the historical on-disk contract.
func TestLocalWriteByteParityWithLegacyWriter(t *testing.T) {
	for name, content := range realFixtures(t) {
		t.Run(name, func(t *testing.T) {
			g, err := graph.Parse(content)
			if err != nil {
				t.Fatalf("fixture does not parse: %v", err)
			}
			legacy := g
			legacy.Version = "dev" // what the old path stamped via cfg.Version()
			want := graph.Serialize(legacy)

			path := configureLocalFile(t, content)
			if _, err := updateFile(func(*Graph) error { return nil }); err != nil {
				t.Fatalf("updateFile: %v", err)
			}
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read back: %v", err)
			}
			if string(got) != want {
				t.Errorf("updateFile output diverges from legacy writer\n got:  %q\n want: %q", got, want)
			}

			// The editor /save path must agree too.
			path2 := configureLocalFile(t, content)
			if err := SaveLocalGraph(g); err != nil {
				t.Fatalf("SaveLocalGraph: %v", err)
			}
			got2, err := os.ReadFile(path2)
			if err != nil {
				t.Fatalf("read back: %v", err)
			}
			if string(got2) != want {
				t.Errorf("SaveLocalGraph output diverges from legacy writer\n got:  %q\n want: %q", got2, want)
			}
		})
	}
}

func TestAtomicWriteFile_ReplacesContentAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "map.flowgo")
	if err := os.WriteFile(path, []byte("old\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(path, []byte("new\n")); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "new\n" {
		t.Errorf("content = %q, want %q", got, "new\n")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("temp litter left in dir: %v", names)
	}
}

func TestAtomicWriteFile_PreservesExistingPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "map.flowgo")
	if err := os.WriteFile(path, []byte("old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(path, []byte("new\n")); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0600 {
		t.Errorf("perm = %o, want 0600 preserved", fi.Mode().Perm())
	}
}

func TestAtomicWriteFile_NewFileGets0644(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fresh.flowgo")
	if err := AtomicWriteFile(path, []byte("x\n")); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0644 {
		t.Errorf("perm = %o, want 0644", fi.Mode().Perm())
	}
}

func TestAtomicWriteFile_FollowsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.flowgo")
	link := filepath.Join(dir, "link.flowgo")
	if err := os.WriteFile(target, []byte("old\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := AtomicWriteFile(link, []byte("new\n")); err != nil {
		t.Fatalf("AtomicWriteFile: %v", err)
	}
	if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("link was replaced by a regular file (err=%v)", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "new\n" {
		t.Errorf("target content = %q, want the write to land through the link", got)
	}
}

// TestCrashMidWriteLeavesTargetIntact simulates the kill -9 story: a
// writer that got as far as producing a temp file (even a torn,
// half-written one) but died before the rename must leave the real
// map byte-for-byte untouched — and the next successful write must
// still go through with the stale temp lying around.
func TestCrashMidWriteLeavesTargetIntact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "map.flowgo")
	original := "node b1 hello 0 0\n"
	if err := os.WriteFile(path, []byte(original), 0644); err != nil {
		t.Fatal(err)
	}
	// The crashed writer's leftovers: a torn temp alongside the map,
	// named like ours would be.
	stale := filepath.Join(dir, ".map.flowgo.tmp-123456")
	if err := os.WriteFile(stale, []byte("node b1 hel"), 0600); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != original {
		t.Fatalf("target changed without any rename: %q", got)
	}
	if err := AtomicWriteFile(path, []byte("node b1 bye 0 0\n")); err != nil {
		t.Fatalf("write with stale temp present: %v", err)
	}
	got, _ = os.ReadFile(path)
	if string(got) != "node b1 bye 0 0\n" {
		t.Errorf("content = %q after write", got)
	}
}

// TestExternalEditIsPickedUp guards the maps-as-code contract: the
// file on disk stays the source of truth, so an edit made behind the
// server's back (vim, git checkout) must surface on the next read
// even though a parsed copy is cached.
func TestExternalEditIsPickedUp(t *testing.T) {
	path := configureLocalFile(t, "node b1 hello 0 0\n")
	g, err := readFile()
	if err != nil {
		t.Fatalf("first read: %v", err)
	}
	if g.Maps[0].Boxes[0].Label != "hello" {
		t.Fatalf("unexpected first read: %+v", g.Maps[0])
	}
	if err := os.WriteFile(path, []byte("node b1 edited 0 0\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// Force an mtime the cache can't mistake for its own even on a
	// coarse-granularity filesystem.
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatal(err)
	}
	g, err = readFile()
	if err != nil {
		t.Fatalf("second read: %v", err)
	}
	if g.Maps[0].Boxes[0].Label != "edited" {
		t.Errorf("external edit not picked up: %+v", g.Maps[0])
	}
}

// TestMutatorErrorDoesNotPoisonCache extends the existing on-disk
// guarantee (mutator error → file untouched) to the cache: a
// half-applied mutation must not be visible on the next read.
func TestMutatorErrorDoesNotPoisonCache(t *testing.T) {
	configureLocalFile(t, "node b1 hello 0 0\n")
	sentinel := errFromFn{}
	_, err := updateFile(func(g *Graph) error {
		g.Maps[0].Boxes[0].Label = "half-applied"
		return sentinel
	})
	if err != sentinel {
		t.Fatalf("err = %v, want the sentinel", err)
	}
	g, err := readFile()
	if err != nil {
		t.Fatalf("read after failed update: %v", err)
	}
	if got := g.Maps[0].Boxes[0].Label; got != "hello" {
		t.Errorf("label = %q, want the half-applied mutation dropped", got)
	}
}

// TestNoopUpdateSkipsRewrite: a mutation that changes nothing must not
// churn the file's mtime (git status noise, file-watcher wakeups).
func TestNoopUpdateSkipsRewrite(t *testing.T) {
	// Content must already be byte-canonical with the current version
	// stamp, otherwise the update legitimately rewrites.
	canonical := graph.Serialize(graph.Graph{
		Version: "dev",
		Maps: []graph.NamedMap{{
			Path:  "/",
			Boxes: []graph.Box{{ID: "b1", Label: "hello"}},
		}},
	})
	path := configureLocalFile(t, canonical)
	past := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatal(err)
	}
	if _, err := updateFile(func(*Graph) error { return nil }); err != nil {
		t.Fatalf("updateFile: %v", err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !fi.ModTime().Equal(past) {
		t.Errorf("mtime advanced to %v — the no-op update rewrote the file", fi.ModTime())
	}
}

// TestReadFileReturnsIndependentCopies: mutating one read's result
// must not leak into the cache or later reads.
func TestReadFileReturnsIndependentCopies(t *testing.T) {
	configureLocalFile(t, "node b1 hello 0 0\n")
	first, err := readFile()
	if err != nil {
		t.Fatal(err)
	}
	first.Maps[0].Boxes[0].Label = "mutated by caller"
	second, err := readFile()
	if err != nil {
		t.Fatal(err)
	}
	if got := second.Maps[0].Boxes[0].Label; got != "hello" {
		t.Errorf("label = %q — caller mutation leaked into the cache", got)
	}
}

// TestSaveThenStateMatchesFreshParse: after an editor /save, reads
// must observe exactly what a fresh parse of the file would say (the
// cache is never seeded from the un-normalized /save payload).
func TestSaveThenStateMatchesFreshParse(t *testing.T) {
	path := configureLocalFile(t, "node b1 hello 0 0\n")
	if err := SaveLocalGraph(graph.Graph{Maps: []graph.NamedMap{{
		Path:  "/",
		Boxes: []graph.Box{{ID: "b1", Label: "saved", X: 10, Y: 20}},
	}}}); err != nil {
		t.Fatalf("SaveLocalGraph: %v", err)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want, err := graph.Parse(string(onDisk))
	if err != nil {
		t.Fatalf("saved file does not parse: %v", err)
	}
	got, err := LocalGraph()
	if err != nil {
		t.Fatalf("LocalGraph: %v", err)
	}
	if got.Maps[0].Boxes[0].Label != "saved" || got.Version != want.Version {
		t.Errorf("LocalGraph = %+v, want the freshly parsed save", got)
	}
	if got.Maps[0].Boxes[0].X != 10 || got.Maps[0].Boxes[0].Y != 20 {
		t.Errorf("coordinates lost through save/read: %+v", got.Maps[0].Boxes[0])
	}
}
