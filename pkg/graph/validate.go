package graph

import (
	"fmt"
	"strings"
)

// Validate runs semantic checks the .flowgo parser doesn't perform.
// Returns every violation it finds rather than stopping at the first one,
// so a single CI run surfaces all problems at once.
func Validate(g Graph) []error {
	var errs []error

	if len(g.Maps) == 0 {
		errs = append(errs, fmt.Errorf("graph has no maps"))
		return errs
	}

	mapsByPath := make(map[string]int, len(g.Maps))
	for i, m := range g.Maps {
		if !isValidMapPath(m.Path) {
			errs = append(errs, fmt.Errorf("map[%d]: invalid path %q", i, m.Path))
		}
		if prev, ok := mapsByPath[m.Path]; ok {
			errs = append(errs, fmt.Errorf("map %q: duplicate (also at index %d)", m.Path, prev))
		}
		mapsByPath[m.Path] = i
	}

	for _, m := range g.Maps {
		errs = append(errs, validateMap(m)...)
	}

	// Submap paths chain to a parent box: "/A/B" requires box A on "/" and
	// box B on "/A". Catches orphaned submaps left after a manual edit.
	for _, m := range g.Maps {
		if m.Path == "/" {
			continue
		}
		segs := strings.Split(strings.TrimPrefix(m.Path, "/"), "/")
		parent := "/"
		for i, seg := range segs {
			parentIdx, ok := mapsByPath[parent]
			if !ok {
				errs = append(errs, fmt.Errorf("map %q: parent %q does not exist", m.Path, parent))
				break
			}
			if !mapHasBox(g.Maps[parentIdx], seg) {
				errs = append(errs, fmt.Errorf("map %q: segment %d (%q) is not a box on %q", m.Path, i+1, seg, parent))
				break
			}
			if parent == "/" {
				parent = "/" + seg
			} else {
				parent = parent + "/" + seg
			}
		}
	}

	return errs
}

func validateMap(m NamedMap) []error {
	var errs []error

	boxIDs := make(map[string]struct{}, len(m.Boxes))
	for i, b := range m.Boxes {
		if b.ID == "" {
			errs = append(errs, fmt.Errorf("map %q: box[%d] has empty id", m.Path, i))
		}
		if _, dup := boxIDs[b.ID]; dup {
			errs = append(errs, fmt.Errorf("map %q: duplicate box id %q", m.Path, b.ID))
		}
		boxIDs[b.ID] = struct{}{}
		if !validPalette(b.Palette) {
			errs = append(errs, fmt.Errorf("map %q: box %q has invalid palette %d (allowed: 0, 2..9)", m.Path, b.ID, b.Palette))
		}
		if !validFont(b.Font) {
			errs = append(errs, fmt.Errorf("map %q: box %q has invalid font %d (allowed: 0, 2..9)", m.Path, b.ID, b.Font))
		}
		if len(b.Label) > MaxLabelLen {
			errs = append(errs, fmt.Errorf("map %q: box %q label is %d chars (cap is %d)", m.Path, b.ID, len(b.Label), MaxLabelLen))
		}
		// `\n` round-trips through the line-based format via the
		// quote()/tokenize() escape pair, so multi-line labels are
		// allowed. `\r` has no escape and would corrupt the file.
		if strings.ContainsRune(b.Label, '\r') {
			errs = append(errs, fmt.Errorf("map %q: box %q label contains a carriage return (no escape exists for \\r in the .flowgo format)", m.Path, b.ID))
		}
	}

	for i, e := range m.Edges {
		if _, ok := boxIDs[e.From]; !ok {
			errs = append(errs, fmt.Errorf("map %q: edge[%d] from %q references unknown box", m.Path, i, e.From))
		}
		if _, ok := boxIDs[e.To]; !ok {
			errs = append(errs, fmt.Errorf("map %q: edge[%d] to %q references unknown box", m.Path, i, e.To))
		}
		if e.From == e.To && e.From != "" {
			errs = append(errs, fmt.Errorf("map %q: edge[%d] is a self-loop on %q", m.Path, i, e.From))
		}
		if e.FromHandle != "" && !validHandle(e.FromHandle) {
			errs = append(errs, fmt.Errorf("map %q: edge[%d] fromHandle %q is not one of t/r/b/l/tl/tr/bl/br", m.Path, i, e.FromHandle))
		}
		if e.ToHandle != "" && !validHandle(e.ToHandle) {
			errs = append(errs, fmt.Errorf("map %q: edge[%d] toHandle %q is not one of t/r/b/l/tl/tr/bl/br", m.Path, i, e.ToHandle))
		}
		if !validPalette(e.Palette) {
			errs = append(errs, fmt.Errorf("map %q: edge[%d] has invalid palette %d", m.Path, i, e.Palette))
		}
	}

	itemIDs := make(map[string]string, len(m.Texts)+len(m.Lines)+len(m.Strokes))
	for i, t := range m.Texts {
		if t.ID == "" {
			errs = append(errs, fmt.Errorf("map %q: text[%d] has empty id", m.Path, i))
			continue
		}
		if other, dup := itemIDs[t.ID]; dup {
			errs = append(errs, fmt.Errorf("map %q: text id %q collides with %s", m.Path, t.ID, other))
		}
		itemIDs[t.ID] = "text"
		if !validPalette(t.Palette) {
			errs = append(errs, fmt.Errorf("map %q: text %q has invalid palette %d", m.Path, t.ID, t.Palette))
		}
		if !validFont(t.Font) {
			errs = append(errs, fmt.Errorf("map %q: text %q has invalid font %d", m.Path, t.ID, t.Font))
		}
		if len(t.Label) > MaxLabelLen {
			errs = append(errs, fmt.Errorf("map %q: text %q label is %d chars (cap is %d)", m.Path, t.ID, len(t.Label), MaxLabelLen))
		}
		if strings.ContainsRune(t.Label, '\r') {
			errs = append(errs, fmt.Errorf("map %q: text %q label contains a carriage return (no escape exists for \\r in the .flowgo format)", m.Path, t.ID))
		}
	}
	for i, l := range m.Lines {
		if l.ID == "" {
			errs = append(errs, fmt.Errorf("map %q: line[%d] has empty id", m.Path, i))
			continue
		}
		if other, dup := itemIDs[l.ID]; dup {
			errs = append(errs, fmt.Errorf("map %q: line id %q collides with %s", m.Path, l.ID, other))
		}
		itemIDs[l.ID] = "line"
		if !validPalette(l.Palette) {
			errs = append(errs, fmt.Errorf("map %q: line %q has invalid palette %d", m.Path, l.ID, l.Palette))
		}
	}
	for i, s := range m.Strokes {
		if s.ID == "" {
			errs = append(errs, fmt.Errorf("map %q: stroke[%d] has empty id", m.Path, i))
		} else if other, dup := itemIDs[s.ID]; dup {
			errs = append(errs, fmt.Errorf("map %q: stroke id %q collides with %s", m.Path, s.ID, other))
		} else {
			itemIDs[s.ID] = "stroke"
		}
		if len(s.Points) < 2 {
			errs = append(errs, fmt.Errorf("map %q: stroke %q has %d points (need at least 2)", m.Path, s.ID, len(s.Points)))
		}
		for j, p := range s.Points {
			if len(p) != 2 {
				errs = append(errs, fmt.Errorf("map %q: stroke %q point[%d] has %d coords (need 2)", m.Path, s.ID, j, len(p)))
			}
		}
		if !validPalette(s.Palette) {
			errs = append(errs, fmt.Errorf("map %q: stroke %q has invalid palette %d", m.Path, s.ID, s.Palette))
		}
	}
	for i, img := range m.Images {
		if img.ID == "" {
			errs = append(errs, fmt.Errorf("map %q: image[%d] has empty id", m.Path, i))
			continue
		}
		if other, dup := itemIDs[img.ID]; dup {
			errs = append(errs, fmt.Errorf("map %q: image id %q collides with %s", m.Path, img.ID, other))
		}
		itemIDs[img.ID] = "image"
		if img.Src == "" {
			errs = append(errs, fmt.Errorf("map %q: image %q has empty src", m.Path, img.ID))
		}
		if img.Width <= 0 || img.Height <= 0 {
			errs = append(errs, fmt.Errorf("map %q: image %q has non-positive size %gx%g", m.Path, img.ID, img.Width, img.Height))
		}
	}

	return errs
}

func mapHasBox(m NamedMap, id string) bool {
	for _, b := range m.Boxes {
		if b.ID == id {
			return true
		}
	}
	return false
}

func isValidMapPath(p string) bool {
	if p == "/" {
		return true
	}
	if !strings.HasPrefix(p, "/") {
		return false
	}
	for _, seg := range strings.Split(strings.TrimPrefix(p, "/"), "/") {
		if seg == "" {
			return false
		}
	}
	return true
}

func validPalette(n int) bool { return n == 0 || (n >= 2 && n <= 9) }
func validFont(n int) bool    { return n == 0 || (n >= 2 && n <= 9) }

func validHandle(h string) bool {
	switch h {
	case "t", "r", "b", "l", "tl", "tr", "bl", "br":
		return true
	}
	return false
}
