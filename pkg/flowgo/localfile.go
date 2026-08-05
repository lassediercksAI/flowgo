// Single-file (CLI) persistence.
//
// Before this file existed, every MCP mutation re-read and re-parsed
// the whole .flowgo file, and every write went through os.WriteFile —
// which truncates in place, so a crash mid-write could leave a
// truncated map behind. Both costs are O(file size) per operation,
// which is fine at a few hundred lines and unworkable at 100k+ nodes.
//
// The model here:
//
//   - The parsed Graph is cached in memory. Disk stays the source of
//     truth: every access stats the file first and re-reads whenever
//     the (mtime, size) identity changed under us, so editing the
//     .flowgo file in a text editor while flowgo runs keeps working
//     exactly as before.
//   - The cached Graph is only ever populated by graph.Parse or by an
//     MCP mutation applied on top of a parsed graph — the editor's
//     /save payload records disk identity only and is re-parsed
//     lazily, so /state observes the same parse-normalized document
//     it always has.
//   - All writes go through AtomicWriteFile (temp file + fsync +
//     rename in the target directory), so a kill -9 mid-write leaves
//     either the old bytes or the new bytes, never a torn file.
//   - Writes that would produce byte-identical content are skipped
//     (checked via SHA-256 of the last-known disk bytes), so no-op
//     saves don't churn mtimes for git/file watchers.
//
// The on-disk format is untouched: content is always exactly
// graph.Serialize(g), byte-for-byte what os.WriteFile used to produce.
//
// Everything below except the exported helpers assumes
// cfg.LocalFileMu is held.

package flowgo

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"time"
)

// localCache is the in-memory state for cfg.LocalFile. A single global
// mirrors the package-global cfg (this package is configured once per
// process; the CLI serves exactly one file).
type localCache struct {
	// path is the cfg.LocalFile this cache was built for. A mismatch
	// (Configure with a new file, tests swapping cfg) invalidates
	// everything.
	path string

	// Identity of the bytes we believe are on disk. diskKnown gates
	// the whole block; modTime+size detect external edits cheaply on
	// every access; sum lets writes skip byte-identical content.
	diskKnown bool
	modTime   time.Time
	size      int64
	sum       [sha256.Size]byte

	// The parsed document, present when hasGraph. Only ever populated
	// from graph.Parse or by mutating a parsed graph in place — never
	// directly from an editor /save payload (see package comment).
	hasGraph bool
	graph    Graph
}

var localFile localCache

func resetLocalCacheLocked() {
	localFile = localCache{}
}

// localGraphLocked returns a pointer to the cached parsed graph,
// (re)loading from disk when the cache is missing, built for another
// path, or stale against the file's current (mtime, size).
func localGraphLocked() (*Graph, error) {
	fi, err := os.Stat(cfg.LocalFile)
	if err != nil {
		resetLocalCacheLocked()
		return nil, err
	}
	c := &localFile
	if c.hasGraph && c.path == cfg.LocalFile && c.diskKnown &&
		c.size == fi.Size() && c.modTime.Equal(fi.ModTime()) {
		return &c.graph, nil
	}
	data, err := os.ReadFile(cfg.LocalFile)
	if err != nil {
		resetLocalCacheLocked()
		return nil, err
	}
	g, err := parse(string(data))
	if err != nil {
		resetLocalCacheLocked()
		return nil, err
	}
	// The stat above predates the read: if a writer slipped in between,
	// we hold newer content stamped with an older identity, which only
	// causes a spurious re-read next time — never a stale cache.
	localFile = localCache{
		path:      cfg.LocalFile,
		diskKnown: true,
		modTime:   fi.ModTime(),
		size:      fi.Size(),
		sum:       sha256.Sum256(data),
		hasGraph:  true,
		graph:     g,
	}
	return &localFile.graph, nil
}

// diskAlreadyHasLocked reports whether the bytes with the given sum are
// known to be on disk right now: our recorded identity matches the sum
// AND the file's live stat still matches our record (so an external
// edit since our last IO can't be silently preserved-by-skip).
func diskAlreadyHasLocked(sum [sha256.Size]byte, size int64) bool {
	c := &localFile
	if !c.diskKnown || c.path != cfg.LocalFile || c.sum != sum || c.size != size {
		return false
	}
	fi, err := os.Stat(cfg.LocalFile)
	return err == nil && fi.Size() == c.size && fi.ModTime().Equal(c.modTime)
}

// persistLocalBytesLocked writes data to cfg.LocalFile atomically
// (unless the identical bytes are already there) and records the new
// disk identity. It does NOT touch the hasGraph/graph fields — callers
// decide whether the cached graph still describes these bytes.
func persistLocalBytesLocked(data []byte) error {
	sum := sha256.Sum256(data)
	if diskAlreadyHasLocked(sum, int64(len(data))) {
		return nil
	}
	fi, err := atomicWriteFile(cfg.LocalFile, data)
	if err != nil {
		resetLocalCacheLocked()
		return err
	}
	c := &localFile
	c.path = cfg.LocalFile
	c.diskKnown = true
	c.modTime = fi.ModTime()
	c.size = int64(len(data))
	c.sum = sum
	return nil
}

// persistLocalGraphLocked serializes the cached graph and persists it.
// Call only while localFile.hasGraph holds the document to write.
func persistLocalGraphLocked() error {
	return persistLocalBytesLocked([]byte(serialize(localFile.graph)))
}

// SaveLocalGraph replaces the whole on-disk document — the editor's
// /save path. The graph is stamped with cfg.Version and written
// atomically. The parsed-graph cache is dropped rather than seeded
// from g: the cache must only ever hold parse-normalized documents,
// and re-parsing lazily on the next read keeps /state and MCP reads
// observing exactly what a fresh parse of the file would say.
func SaveLocalGraph(g Graph) error {
	cfg.LocalFileMu.Lock()
	defer cfg.LocalFileMu.Unlock()
	g.Version = cfg.Version()
	err := persistLocalBytesLocked([]byte(serialize(g)))
	localFile.hasGraph = false
	localFile.graph = Graph{}
	return err
}

// LocalGraph returns the current document for cfg.LocalFile — from
// cache when the file is unchanged since the last access, freshly
// parsed otherwise. The result is a deep copy; callers may mutate it
// freely (mutations do not persist — use the MCP path or
// SaveLocalGraph).
func LocalGraph() (Graph, error) {
	return readFile()
}

// AtomicWriteFile writes data to path via a temp file + rename in the
// target's directory, fsyncing before the rename, so a crash at any
// point leaves either the old content or the new content — never a
// truncated hybrid. An existing file's permissions are preserved
// (0644 for new files); a symlink is followed so the target is
// replaced, not the link.
func AtomicWriteFile(path string, data []byte) error {
	_, err := atomicWriteFile(path, data)
	return err
}

// atomicWriteFile is AtomicWriteFile returning the written inode's
// FileInfo, taken from the temp-file fd after the final write+sync.
// Rename preserves inode mtime, so this identity is exactly what a
// later os.Stat of path reports until someone else writes it — using
// the fd (not a post-rename path stat) means a concurrent external
// writer can never get its identity attributed to our content.
func atomicWriteFile(path string, data []byte) (os.FileInfo, error) {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	mode := os.FileMode(0644)
	if fi, err := os.Stat(path); err == nil {
		mode = fi.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	fail := func(e error) (os.FileInfo, error) {
		tmp.Close()
		os.Remove(tmpName)
		return nil, e
	}
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	fi, err := tmp.Stat()
	if err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return nil, err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		os.Remove(tmpName)
		return nil, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return nil, err
	}
	return fi, nil
}

// cloneGraph deep-copies g so callers outside the file mutex can't
// alias the cache. Element structs are value types; only the slices
// (and the nested point lists on lines/strokes) need copying. Nil
// slices stay nil so JSON output is indistinguishable from a fresh
// parse.
func cloneGraph(g Graph) Graph {
	out := g
	if g.Maps == nil {
		return out
	}
	out.Maps = make([]NamedMap, len(g.Maps))
	for i, m := range g.Maps {
		cm := m
		cm.Boxes = cloneSlice(m.Boxes)
		cm.Edges = cloneSlice(m.Edges)
		cm.Texts = cloneSlice(m.Texts)
		cm.Images = cloneSlice(m.Images)
		cm.Lines = cloneSlice(m.Lines)
		for j := range cm.Lines {
			cm.Lines[j].Mids = clonePoints(cm.Lines[j].Mids)
		}
		cm.Strokes = cloneSlice(m.Strokes)
		for j := range cm.Strokes {
			cm.Strokes[j].Points = clonePoints(cm.Strokes[j].Points)
		}
		out.Maps[i] = cm
	}
	return out
}

func cloneSlice[T any](s []T) []T {
	if s == nil {
		return nil
	}
	out := make([]T, len(s))
	copy(out, s)
	return out
}

func clonePoints(p [][]float64) [][]float64 {
	if p == nil {
		return nil
	}
	out := make([][]float64, len(p))
	for i, pt := range p {
		out[i] = cloneSlice(pt)
	}
	return out
}
