package flowgo

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// syntheticGraph builds an n-node map (chain-linked, varied labels)
// purely for SCALE measurement — correctness/parity tests use the real
// checked-in fixtures instead (see localfile_test.go).
func syntheticGraph(n int) graph.Graph {
	m := graph.NamedMap{Path: "/"}
	m.Boxes = make([]graph.Box, n)
	for i := 0; i < n; i++ {
		m.Boxes[i] = graph.Box{
			ID:      fmt.Sprintf("b%d", i+1),
			Label:   fmt.Sprintf("node %d with a plausible label", i+1),
			X:       float64((i % 1000) * 200),
			Y:       float64((i / 1000) * 120),
			Palette: i % 6,
		}
	}
	m.Edges = make([]graph.Edge, n-1)
	for i := 0; i < n-1; i++ {
		m.Edges[i] = graph.Edge{From: m.Boxes[i].ID, To: m.Boxes[i+1].ID}
	}
	return graph.Graph{Version: "dev", Maps: []graph.NamedMap{m}}
}

var benchSizes = []int{1_000, 100_000, 1_000_000}

func BenchmarkParse(b *testing.B) {
	for _, n := range benchSizes {
		text := graph.Serialize(syntheticGraph(n))
		b.Run(fmt.Sprintf("nodes=%d", n), func(b *testing.B) {
			b.SetBytes(int64(len(text)))
			for i := 0; i < b.N; i++ {
				if _, err := graph.Parse(text); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkSerialize(b *testing.B) {
	for _, n := range benchSizes {
		g := syntheticGraph(n)
		b.Run(fmt.Sprintf("nodes=%d", n), func(b *testing.B) {
			for i := 0; i < b.N; i++ {
				_ = graph.Serialize(g)
			}
		})
	}
}

func benchConfigure(b *testing.B, n int) string {
	b.Helper()
	orig := cfg
	b.Cleanup(func() { Configure(orig) })
	path := filepath.Join(b.TempDir(), "bench.flowgo")
	if err := os.WriteFile(path, []byte(graph.Serialize(syntheticGraph(n))), 0644); err != nil {
		b.Fatal(err)
	}
	Configure(Config{LocalFile: path})
	return path
}

// BenchmarkMutationLegacyPath replicates the pre-cache updateFile:
// ReadFile + Parse + mutate + Serialize + WriteFile per mutation.
func BenchmarkMutationLegacyPath(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("nodes=%d", n), func(b *testing.B) {
			path := benchConfigure(b, n)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				data, err := os.ReadFile(path)
				if err != nil {
					b.Fatal(err)
				}
				g, err := graph.Parse(string(data))
				if err != nil {
					b.Fatal(err)
				}
				g.Maps[0].Boxes[0].Label = fmt.Sprintf("iteration %d", i)
				g.Version = "dev"
				if err := os.WriteFile(path, []byte(graph.Serialize(g)), 0644); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkMutationCachedPath is the shipped path: cached parsed graph,
// serialize + atomic write per mutation.
func BenchmarkMutationCachedPath(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("nodes=%d", n), func(b *testing.B) {
			benchConfigure(b, n)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := updateFile(func(g *Graph) error {
					g.Maps[0].Boxes[0].Label = fmt.Sprintf("iteration %d", i)
					return nil
				}); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkReadLegacyPath replicates the pre-cache readFile / /state:
// ReadFile + Parse per read.
func BenchmarkReadLegacyPath(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("nodes=%d", n), func(b *testing.B) {
			path := benchConfigure(b, n)
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				data, err := os.ReadFile(path)
				if err != nil {
					b.Fatal(err)
				}
				if _, err := graph.Parse(string(data)); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkReadCachedPath is the shipped read path: stat + cached
// graph + deep copy.
func BenchmarkReadCachedPath(b *testing.B) {
	for _, n := range benchSizes {
		b.Run(fmt.Sprintf("nodes=%d", n), func(b *testing.B) {
			benchConfigure(b, n)
			if _, err := readFile(); err != nil { // warm the cache
				b.Fatal(err)
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := readFile(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
