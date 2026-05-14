// Package graph defines flowgo's in-memory graph model and the
// .flowgo text-format parser/serializer.
//
// The package is intentionally small: types with their JSON tags
// (which must match the wire format the editor consumes over /state
// and /save), Parse, and Serialize. Anything richer (validation,
// HTTP handlers, MCP tools) lives in the upstream binary or in
// downstream consumers.
package graph

import (
	"bufio"
	"fmt"
	"strconv"
	"strings"
)

// Box is a node on a map. JSON tags are part of the public contract:
// they're consumed by the editor and any other process that exchanges
// graphs as JSON.
type Box struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Sides    int     `json:"sides,omitempty"`
	Palette  int     `json:"palette,omitempty"`
	Font     int     `json:"font,omitempty"`
	Rotation int     `json:"rotation,omitempty"`
	// Anchor marks this box as the map-level recenter target. At most
	// one box per map carries Anchor=true; the parser/serializer enforce
	// the invariant. Persisted in the .flowgo text format as a separate
	// per-map `anchor <id>` directive rather than a positional token.
	Anchor bool `json:"anchor,omitempty"`
}

// Edge connects two boxes within the same map.
type Edge struct {
	From       string `json:"from"`
	FromHandle string `json:"fromHandle,omitempty"`
	To         string `json:"to"`
	ToHandle   string `json:"toHandle,omitempty"`
}

// Text is a free-floating annotation.
type Text struct {
	ID      string  `json:"id"`
	Label   string  `json:"label"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Palette int     `json:"palette,omitempty"`
	Font    int     `json:"font,omitempty"`
}

// Line is a static two-point segment.
type Line struct {
	ID string  `json:"id"`
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
	X2 float64 `json:"x2"`
	Y2 float64 `json:"y2"`
}

// Stroke is a freehand polyline (brush mode).
type Stroke struct {
	ID      string      `json:"id"`
	Points  [][]float64 `json:"points"`
	Palette int         `json:"palette,omitempty"`
}

// NamedMap is one canvas at a given path. Submap paths are slash-
// separated box ids: "/A/B" hangs off box A on "/" and box B on "/A".
type NamedMap struct {
	Path    string   `json:"path"`
	Boxes   []Box    `json:"boxes"`
	Edges   []Edge   `json:"edges"`
	Texts   []Text   `json:"texts,omitempty"`
	Lines   []Line   `json:"lines,omitempty"`
	Strokes []Stroke `json:"strokes,omitempty"`
}

// Graph is the full document — every map keyed by its path.
type Graph struct {
	Maps []NamedMap `json:"maps"`
}

// Parse reads the .flowgo text format and returns the resulting Graph.
// Unknown directives produce an error rather than being silently
// dropped, so a downstream package init that depends on Parse fails
// loudly when the format gains a new directive.
func Parse(s string) (Graph, error) {
	var g Graph
	findOrCreate := func(path string) int {
		for i, m := range g.Maps {
			if m.Path == path {
				return i
			}
		}
		g.Maps = append(g.Maps, NamedMap{Path: path})
		return len(g.Maps) - 1
	}
	cur := findOrCreate("/")

	sc := bufio.NewScanner(strings.NewReader(s))
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		toks := tokenize(line)
		if len(toks) == 0 {
			continue
		}
		switch toks[0] {
		case "map":
			if len(toks) < 2 {
				return g, fmt.Errorf("line %d: map needs path", lineNo)
			}
			cur = findOrCreate(toks[1])
		case "box":
			if len(toks) < 5 {
				return g, fmt.Errorf("line %d: box needs id label x y", lineNo)
			}
			x, err := strconv.ParseFloat(toks[3], 64)
			if err != nil {
				return g, fmt.Errorf("line %d: bad x: %v", lineNo, err)
			}
			y, err := strconv.ParseFloat(toks[4], 64)
			if err != nil {
				return g, fmt.Errorf("line %d: bad y: %v", lineNo, err)
			}
			box := Box{ID: toks[1], Label: toks[2], X: x, Y: y}
			if len(toks) >= 6 {
				sides, err := strconv.Atoi(toks[5])
				if err != nil {
					return g, fmt.Errorf("line %d: bad sides: %v", lineNo, err)
				}
				if sides == 3 || sides == 5 || sides == 6 {
					box.Sides = sides
				}
			}
			if len(toks) >= 7 {
				palette, err := strconv.Atoi(toks[6])
				if err != nil {
					return g, fmt.Errorf("line %d: bad palette: %v", lineNo, err)
				}
				if palette >= 2 && palette <= 9 {
					box.Palette = palette
				}
			}
			if len(toks) >= 8 {
				font, err := strconv.Atoi(toks[7])
				if err != nil {
					return g, fmt.Errorf("line %d: bad font: %v", lineNo, err)
				}
				if font >= 2 && font <= 9 {
					box.Font = font
				}
			}
			if len(toks) >= 9 {
				rot, err := strconv.Atoi(toks[8])
				if err != nil {
					return g, fmt.Errorf("line %d: bad rotation: %v", lineNo, err)
				}
				rot = ((rot % 360) + 360) % 360
				if rot != 0 {
					box.Rotation = rot
				}
			}
			g.Maps[cur].Boxes = append(g.Maps[cur].Boxes, box)
		case "edge":
			if len(toks) < 3 {
				return g, fmt.Errorf("line %d: edge needs from to", lineNo)
			}
			fromID, fromH := splitEndpoint(toks[1])
			toID, toH := splitEndpoint(toks[2])
			g.Maps[cur].Edges = append(g.Maps[cur].Edges, Edge{From: fromID, FromHandle: fromH, To: toID, ToHandle: toH})
		case "text":
			if len(toks) < 5 {
				return g, fmt.Errorf("line %d: text needs id label x y", lineNo)
			}
			x, err := strconv.ParseFloat(toks[3], 64)
			if err != nil {
				return g, fmt.Errorf("line %d: bad x: %v", lineNo, err)
			}
			y, err := strconv.ParseFloat(toks[4], 64)
			if err != nil {
				return g, fmt.Errorf("line %d: bad y: %v", lineNo, err)
			}
			t := Text{ID: toks[1], Label: toks[2], X: x, Y: y}
			if len(toks) >= 6 {
				palette, err := strconv.Atoi(toks[5])
				if err != nil {
					return g, fmt.Errorf("line %d: bad text palette: %v", lineNo, err)
				}
				if palette >= 2 && palette <= 9 {
					t.Palette = palette
				}
			}
			if len(toks) >= 7 {
				font, err := strconv.Atoi(toks[6])
				if err != nil {
					return g, fmt.Errorf("line %d: bad text font: %v", lineNo, err)
				}
				if font >= 2 && font <= 9 {
					t.Font = font
				}
			}
			g.Maps[cur].Texts = append(g.Maps[cur].Texts, t)
		case "line":
			if len(toks) < 6 {
				return g, fmt.Errorf("line %d: line needs id x1 y1 x2 y2", lineNo)
			}
			coords := make([]float64, 4)
			for i, t := range toks[2:6] {
				v, err := strconv.ParseFloat(t, 64)
				if err != nil {
					return g, fmt.Errorf("line %d: bad coord: %v", lineNo, err)
				}
				coords[i] = v
			}
			g.Maps[cur].Lines = append(g.Maps[cur].Lines, Line{ID: toks[1], X1: coords[0], Y1: coords[1], X2: coords[2], Y2: coords[3]})
		case "anchor":
			if len(toks) < 2 {
				return g, fmt.Errorf("line %d: anchor needs id", lineNo)
			}
			id := toks[1]
			found := false
			for i := range g.Maps[cur].Boxes {
				if g.Maps[cur].Boxes[i].ID == id {
					g.Maps[cur].Boxes[i].Anchor = true
					found = true
				} else {
					// Enforce single anchor per map: clear any prior winners.
					g.Maps[cur].Boxes[i].Anchor = false
				}
			}
			if !found {
				return g, fmt.Errorf("line %d: anchor refers to unknown box %q", lineNo, id)
			}
		case "stroke":
			if len(toks) < 4 {
				return g, fmt.Errorf("line %d: stroke needs id and at least two points", lineNo)
			}
			// Optional palette token (a non-comma token after the id):
			// `stroke <id> [palette] x,y x,y ...`. Points always carry a
			// comma so the two forms are unambiguous.
			pointStart := 2
			palette := 0
			if !strings.ContainsRune(toks[2], ',') {
				p, err := strconv.Atoi(toks[2])
				if err != nil {
					return g, fmt.Errorf("line %d: bad stroke palette: %v", lineNo, err)
				}
				palette = p
				pointStart = 3
				if len(toks) < 5 {
					return g, fmt.Errorf("line %d: stroke needs at least two points", lineNo)
				}
			}
			pts := make([][]float64, 0, len(toks)-pointStart)
			for _, pair := range toks[pointStart:] {
				parts := strings.SplitN(pair, ",", 2)
				if len(parts) != 2 {
					return g, fmt.Errorf("line %d: bad stroke point %q", lineNo, pair)
				}
				px, err := strconv.ParseFloat(parts[0], 64)
				if err != nil {
					return g, fmt.Errorf("line %d: bad stroke x: %v", lineNo, err)
				}
				py, err := strconv.ParseFloat(parts[1], 64)
				if err != nil {
					return g, fmt.Errorf("line %d: bad stroke y: %v", lineNo, err)
				}
				pts = append(pts, []float64{px, py})
			}
			g.Maps[cur].Strokes = append(g.Maps[cur].Strokes, Stroke{ID: toks[1], Points: pts, Palette: palette})
		default:
			return g, fmt.Errorf("line %d: unknown directive %q", lineNo, toks[0])
		}
	}
	return g, sc.Err()
}

// Serialize emits the .flowgo text format. Empty maps are dropped —
// they get re-created on demand if a consumer navigates back to them.
func Serialize(g Graph) string {
	var b strings.Builder
	var nonEmpty []NamedMap
	for _, m := range g.Maps {
		if len(m.Boxes) == 0 && len(m.Edges) == 0 && len(m.Texts) == 0 && len(m.Lines) == 0 && len(m.Strokes) == 0 {
			continue
		}
		nonEmpty = append(nonEmpty, m)
	}
	multi := len(nonEmpty) > 1
	for i, m := range nonEmpty {
		if i > 0 {
			b.WriteString("\n")
		}
		if multi || m.Path != "/" {
			fmt.Fprintf(&b, "map %s\n", m.Path)
		}
		// Belt-and-suspenders against poisoning the on-disk file:
		// an empty id round-trips as `text  "label" 0 0`, which the
		// parser rejects, locking out every subsequent updateFile()
		// call. Synthesize unique ids per map at emit time without
		// mutating the caller's graph.
		used := make(map[string]struct{}, len(m.Boxes)+len(m.Texts)+len(m.Lines)+len(m.Strokes))
		for _, x := range m.Boxes {
			if x.ID != "" {
				used[x.ID] = struct{}{}
			}
		}
		for _, x := range m.Texts {
			if x.ID != "" {
				used[x.ID] = struct{}{}
			}
		}
		for _, x := range m.Lines {
			if x.ID != "" {
				used[x.ID] = struct{}{}
			}
		}
		for _, x := range m.Strokes {
			if x.ID != "" {
				used[x.ID] = struct{}{}
			}
		}
		fallbackID := func(prefix string) string {
			for n := 1; ; n++ {
				id := fmt.Sprintf("%s%d", prefix, n)
				if _, taken := used[id]; !taken {
					used[id] = struct{}{}
					return id
				}
			}
		}
		for _, box := range m.Boxes {
			emitSides := box.Sides == 3 || box.Sides == 5 || box.Sides == 6
			emitPalette := box.Palette >= 2 && box.Palette <= 9
			emitFont := box.Font >= 2 && box.Font <= 9
			emitRotation := box.Rotation != 0
			fmt.Fprintf(&b, "box %s %s %g %g", box.ID, quote(box.Label), box.X, box.Y)
			if emitSides || emitPalette || emitFont || emitRotation {
				sides := box.Sides
				if !emitSides {
					sides = 4
				}
				fmt.Fprintf(&b, " %d", sides)
			}
			if emitPalette || emitFont || emitRotation {
				palette := box.Palette
				if !emitPalette {
					palette = 1
				}
				fmt.Fprintf(&b, " %d", palette)
			}
			if emitFont || emitRotation {
				font := box.Font
				if !emitFont {
					font = 1
				}
				fmt.Fprintf(&b, " %d", font)
			}
			if emitRotation {
				fmt.Fprintf(&b, " %d", box.Rotation)
			}
			b.WriteString("\n")
		}
		// Single-anchor invariant: emit at most one `anchor <id>` line.
		// First Anchor=true wins; later occurrences are ignored.
		for _, box := range m.Boxes {
			if box.Anchor {
				fmt.Fprintf(&b, "anchor %s\n", box.ID)
				break
			}
		}
		if len(m.Boxes) > 0 && len(m.Edges) > 0 {
			b.WriteString("\n")
		}
		for _, e := range m.Edges {
			fmt.Fprintf(&b, "edge %s %s\n", joinEndpoint(e.From, e.FromHandle), joinEndpoint(e.To, e.ToHandle))
		}
		if (len(m.Boxes) > 0 || len(m.Edges) > 0) && len(m.Texts) > 0 {
			b.WriteString("\n")
		}
		for _, t := range m.Texts {
			emitTPalette := t.Palette >= 2 && t.Palette <= 9
			emitTFont := t.Font >= 2 && t.Font <= 9
			id := t.ID
			if id == "" {
				id = fallbackID("t")
			}
			fmt.Fprintf(&b, "text %s %s %g %g", id, quote(t.Label), t.X, t.Y)
			if emitTPalette || emitTFont {
				palette := t.Palette
				if !emitTPalette {
					palette = 1
				}
				fmt.Fprintf(&b, " %d", palette)
			}
			if emitTFont {
				fmt.Fprintf(&b, " %d", t.Font)
			}
			b.WriteString("\n")
		}
		if (len(m.Boxes) > 0 || len(m.Edges) > 0 || len(m.Texts) > 0) && len(m.Lines) > 0 {
			b.WriteString("\n")
		}
		for _, l := range m.Lines {
			id := l.ID
			if id == "" {
				id = fallbackID("l")
			}
			fmt.Fprintf(&b, "line %s %g %g %g %g\n", id, l.X1, l.Y1, l.X2, l.Y2)
		}
		if (len(m.Boxes) > 0 || len(m.Edges) > 0 || len(m.Texts) > 0 || len(m.Lines) > 0) && len(m.Strokes) > 0 {
			b.WriteString("\n")
		}
		for _, s := range m.Strokes {
			if len(s.Points) < 2 {
				continue
			}
			id := s.ID
			if id == "" {
				id = fallbackID("s")
			}
			fmt.Fprintf(&b, "stroke %s", id)
			if s.Palette >= 2 && s.Palette <= 9 {
				fmt.Fprintf(&b, " %d", s.Palette)
			}
			for _, p := range s.Points {
				if len(p) < 2 {
					continue
				}
				fmt.Fprintf(&b, " %g,%g", p[0], p[1])
			}
			b.WriteString("\n")
		}
	}
	return b.String()
}

func tokenize(line string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	escape := false
	for _, r := range line {
		switch {
		case escape:
			// `\n` decodes to a newline so multi-line labels round-trip
			// through the line-based file format. `\\` and `\"` keep
			// their original meanings; any other escaped rune is
			// passed through verbatim (back-compat with old files).
			switch r {
			case 'n':
				cur.WriteByte('\n')
			default:
				cur.WriteRune(r)
			}
			escape = false
		case r == '\\':
			escape = true
		case r == '"':
			inQuote = !inQuote
		case !inQuote && (r == ' ' || r == '\t'):
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func splitEndpoint(s string) (string, string) {
	if i := strings.Index(s, ":"); i >= 0 {
		return s[:i], s[i+1:]
	}
	return s, ""
}

func joinEndpoint(id, handle string) string {
	if handle == "" {
		return id
	}
	return id + ":" + handle
}

func quote(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\n\"\\") {
		r := strings.NewReplacer(
			"\\", "\\\\",
			"\"", "\\\"",
			"\n", "\\n",
		)
		return "\"" + r.Replace(s) + "\""
	}
	return s
}
