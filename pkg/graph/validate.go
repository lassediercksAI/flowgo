package graph

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Validate runs semantic checks the .flowgo parser doesn't perform.
// Returns every violation it finds rather than stopping at the first one,
// so a single CI run surfaces all problems at once.
//
// It is a superset of ValidateWritable: everything that would corrupt
// the file, plus complaints about graphs that persist perfectly well
// but don't mean anything sensible (orphaned submaps, edges pointing
// at deleted nodes, out-of-range styles).
func Validate(g Graph) []error {
	errs := ValidateWritable(g)

	// The parser tolerates out-of-range shape ids in existing files
	// (`defaultshape 7` degrades to a rectangle) so a file written by a
	// future format version still opens here. Nothing at THIS version
	// may mint one, though: it would persist an id every renderer
	// silently falls back from. Validate gates the caller-supplied
	// write boundaries (set_state, create_map), so unknown ids get a
	// proper error there instead of reaching disk.
	if !validShape(g.DefaultShape) {
		errs = append(errs, fmt.Errorf("defaultShape %d is not a known shape (allowed: 0 rectangle, 1 hexagon, 2 circle, 3 triangle)", g.DefaultShape))
	}

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

// ValidateWritable returns only the violations that would damage the
// .flowgo file itself — fields whose bytes do not survive a
// Serialize → Parse round-trip. Every path that writes a caller-
// supplied graph to disk must run this first.
//
// The distinction from Validate matters: a mid-edit document can
// legitimately fail Validate (a submap outliving the node it hung off,
// an edge whose target was just deleted) while serializing and
// re-parsing perfectly. Gating saves on the full validator would lock
// the editor out of persisting documents it is allowed to produce,
// which is a worse failure than the corruption being prevented. This
// subset only rejects input that cannot be written down at all.
//
// The invariant it buys: for any g with no ValidateWritable errors,
// Parse(Serialize(g)) succeeds and returns the same elements.
func ValidateWritable(g Graph) []error {
	var errs []error
	for i, m := range g.Maps {
		if p := stringProblem(m.Path); p != "" {
			errs = append(errs, fmt.Errorf("map[%d]: path %q %s", i, m.Path, p))
		}
		errs = append(errs, validateWritableMap(m)...)
	}
	return errs
}

func validateWritableMap(m NamedMap) []error {
	var errs []error
	id := func(kind string, i int, v string) {
		if v == "" {
			errs = append(errs, fmt.Errorf("map %q: %s[%d] has empty id", m.Path, kind, i))
			return
		}
		if p := idProblem(v); p != "" {
			errs = append(errs, fmt.Errorf("map %q: %s id %q %s", m.Path, kind, v, p))
		}
	}
	label := func(kind, owner, v string) {
		if strings.ContainsRune(v, '\r') {
			errs = append(errs, fmt.Errorf("map %q: %s %q label contains a carriage return (it would be written as a newline — normalize it first, see NormalizeLabel)", m.Path, kind, owner))
		}
	}
	for i, b := range m.Boxes {
		id("box", i, b.ID)
		label("box", b.ID, b.Label)
	}
	for i, t := range m.Texts {
		id("text", i, t.ID)
		label("text", t.ID, t.Label)
	}
	for i, l := range m.Lines {
		id("line", i, l.ID)
	}
	for i, s := range m.Strokes {
		id("stroke", i, s.ID)
	}
	for i, img := range m.Images {
		id("image", i, img.ID)
		if strings.ContainsRune(img.Src, '\r') {
			errs = append(errs, fmt.Errorf("map %q: image %q src contains a carriage return", m.Path, img.ID))
		}
	}
	// Edge endpoints are ids too, but they are written through
	// joinEndpoint, where ':' additionally separates the handle.
	for i, e := range m.Edges {
		for _, ep := range []struct {
			what string
			v    string
		}{{"from", e.From}, {"to", e.To}} {
			if ep.v == "" {
				errs = append(errs, fmt.Errorf("map %q: edge[%d] has empty %s", m.Path, i, ep.what))
			} else if p := idProblem(ep.v); p != "" {
				errs = append(errs, fmt.Errorf("map %q: edge[%d] %s %q %s", m.Path, i, ep.what, ep.v, p))
			}
		}
		// The label goes through quote() like a node's, so the same
		// carriage-return rule applies (it would come back as a
		// newline). Everything else quoting handles.
		label("edge", fmt.Sprintf("%s-%s", e.From, e.To), e.Label)
	}
	return errs
}

// idProblem reports why an id cannot be written to a .flowgo file, or
// "" when it is safe. The format is line-based and whitespace-
// delimited, so an id carrying structure either splits its own
// directive into something the parser rejects outright — which bricks
// the file for every later read, since nothing can re-open it — or
// comes back as a different id, silently orphaning the edges and
// submaps that pointed at it. Serialize quotes ids defensively, but
// quoting cannot save ':' (splitEndpoint still cuts the endpoint in
// two) and the rewrite would be invisible to the caller, so the
// boundary rejects instead of repairing.
func idProblem(id string) string {
	if p := stringProblem(id); p != "" {
		return p
	}
	if strings.ContainsRune(id, ':') {
		return "contains ':' (reserved as the edge handle separator)"
	}
	return ""
}

// stringProblem covers the characters no .flowgo token may contain,
// shared by ids and map paths. A line break is reported ahead of any
// other complaint even when it appears later in the string: it's the
// one that forges a whole extra directive, so it's the one worth
// naming in the error a client sees.
func stringProblem(s string) string {
	if strings.ContainsAny(s, "\n\r") {
		return "contains a line break"
	}
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			return "contains whitespace"
		case unicode.IsControl(r):
			return "contains a control character"
		case r == '"':
			return `contains a double quote`
		case r == '\\':
			return `contains a backslash`
		}
	}
	return ""
}

func validateMap(m NamedMap) []error {
	var errs []error

	// Empty / malformed ids and carriage returns are reported by
	// ValidateWritable, which Validate runs first — checking them again
	// here would double up every message.
	boxIDs := make(map[string]struct{}, len(m.Boxes))
	for _, b := range m.Boxes {
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
		if !validShape(b.Shape) {
			errs = append(errs, fmt.Errorf("map %q: box %q has invalid shape %d (allowed: 0 rectangle, 1 hexagon, 2 circle, 3 triangle)", m.Path, b.ID, b.Shape))
		}
		if n := utf8.RuneCountInString(b.Label); n > MaxLabelLen {
			errs = append(errs, fmt.Errorf("map %q: box %q label is %d chars (cap is %d)", m.Path, b.ID, n, MaxLabelLen))
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
		if n := utf8.RuneCountInString(e.Label); n > MaxLabelLen {
			errs = append(errs, fmt.Errorf("map %q: edge[%d] label is %d chars (cap is %d)", m.Path, i, n, MaxLabelLen))
		}
	}

	itemIDs := make(map[string]string, len(m.Texts)+len(m.Lines)+len(m.Strokes))
	for _, t := range m.Texts {
		if t.ID == "" {
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
		if n := utf8.RuneCountInString(t.Label); n > MaxLabelLen {
			errs = append(errs, fmt.Errorf("map %q: text %q label is %d chars (cap is %d)", m.Path, t.ID, n, MaxLabelLen))
		}
	}
	for _, l := range m.Lines {
		if l.ID == "" {
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
	for _, s := range m.Strokes {
		if other, dup := itemIDs[s.ID]; s.ID != "" && dup {
			errs = append(errs, fmt.Errorf("map %q: stroke id %q collides with %s", m.Path, s.ID, other))
		} else if s.ID != "" {
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
	for _, img := range m.Images {
		if img.ID == "" {
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

// validShape mirrors shapeProp at the MCP layer: 0 rectangle,
// 1 hexagon, 2 circle, 3 triangle. 4-9 are reserved in the file format
// and readable (parse tolerance), but not writable through Validate'd
// boundaries.
func validShape(n int) bool { return n >= 0 && n <= 3 }

func validHandle(h string) bool {
	switch h {
	case "t", "r", "b", "l", "tl", "tr", "bl", "br":
		return true
	}
	return false
}
