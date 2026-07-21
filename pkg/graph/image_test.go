package graph

import (
	"strings"
	"testing"
)

// image directives round-trip through Parse: id, src, x, y, width,
// height. Coordinates and size are plain floats like line/box.
func TestParseImage(t *testing.T) {
	g, err := Parse("image img1 flowgo-media/abc123.png 10 20 300 200")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(g.Maps) != 1 || len(g.Maps[0].Images) != 1 {
		t.Fatalf("expected exactly one image: %+v", g)
	}
	img := g.Maps[0].Images[0]
	if img.ID != "img1" || img.Src != "flowgo-media/abc123.png" {
		t.Fatalf("bad id/src: %+v", img)
	}
	if img.X != 10 || img.Y != 20 || img.Width != 300 || img.Height != 200 {
		t.Fatalf("bad geometry: %+v", img)
	}
}

func TestParseImageTooFewTokens(t *testing.T) {
	if _, err := Parse("image img1 flowgo-media/abc.png 10 20 300"); err == nil {
		t.Fatal("expected error for missing height")
	}
}

// Serialize emits `image <id> <src> <x> <y> <w> <h>` after the stroke
// block, and Parse(Serialize(g)) preserves every field.
func TestImageRoundTrip(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path: "/",
		Images: []Image{
			{ID: "img1", Src: "flowgo-media/abc123.png", X: 10, Y: 20, Width: 300, Height: 200},
		},
	}}}
	out := Serialize(g)
	if !strings.Contains(out, "image img1 flowgo-media/abc123.png 10 20 300 200") {
		t.Fatalf("unexpected serialization:\n%s", out)
	}
	g2, err := Parse(out)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if len(g2.Maps[0].Images) != 1 || g2.Maps[0].Images[0] != g.Maps[0].Images[0] {
		t.Fatalf("round-trip mismatch: %+v", g2.Maps[0].Images)
	}
}

// A src that needs quoting (defensive — real paths have no spaces)
// still round-trips through the quote()/tokenize() escape pair.
func TestImageQuotedSrcRoundTrip(t *testing.T) {
	g := Graph{Maps: []NamedMap{{
		Path:   "/",
		Images: []Image{{ID: "img1", Src: "media/a b.png", X: 0, Y: 0, Width: 100, Height: 100}},
	}}}
	g2, err := Parse(Serialize(g))
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if g2.Maps[0].Images[0].Src != "media/a b.png" {
		t.Fatalf("quoted src lost: %q", g2.Maps[0].Images[0].Src)
	}
}
