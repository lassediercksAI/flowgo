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
//
// The `.flowgo` text format keeps a vestigial "sides" slot between
// the y coordinate and the palette token (always emitted as 4) so old
// box directives like `box b1 hi 0 0 3 5` still parse positionally —
// the polygon feature is gone, but the wire layout is preserved.
type Box struct {
	ID      string  `json:"id"`
	Label   string  `json:"label"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Palette int     `json:"palette,omitempty"`
	Font    int     `json:"font,omitempty"`
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
	Palette    int    `json:"palette,omitempty"`
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

// Line is a static segment that runs through its endpoints and any
// intermediate Mid control points. Style governs how each pair of
// consecutive points is drawn: 1 (or 0/unset) renders straight
// segments (sharp polyline), 2 renders a smooth quadratic-bezier
// chain, 3 renders right-angle elbows (orthogonal).
type Line struct {
	ID      string      `json:"id"`
	X1      float64     `json:"x1"`
	Y1      float64     `json:"y1"`
	X2      float64     `json:"x2"`
	Y2      float64     `json:"y2"`
	Palette int         `json:"palette,omitempty"`
	Style   int         `json:"style,omitempty"`
	Mids    [][]float64 `json:"mids,omitempty"`
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
//
// Version records the flowgo binary version that last wrote this graph.
// It's stamped at save time and surfaced for tools that need to gate
// behaviour on the writer's version. Empty Version means the file
// pre-dates the directive (older flowgo) and should be treated as
// "unknown".
type Graph struct {
	Version string     `json:"version,omitempty"`
	Maps    []NamedMap `json:"maps"`
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
		case "version":
			// `version <semver>` records the flowgo binary that last wrote
			// this file. Last occurrence wins so a corrupted leading
			// directive can be repaired by appending a corrected one.
			if len(toks) < 2 {
				return g, fmt.Errorf("line %d: version needs a value", lineNo)
			}
			g.Version = toks[1]
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
			// toks[5] is the vestigial "sides" slot. We still validate
			// it's numeric (so corrupted files fail loudly) but discard
			// the value — polygons aren't a feature anymore.
			if len(toks) >= 6 {
				if _, err := strconv.Atoi(toks[5]); err != nil {
					return g, fmt.Errorf("line %d: bad sides: %v", lineNo, err)
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
			// toks[8] is the vestigial "rotation" slot from polygon
			// support. Validate-and-discard for the same reason as sides.
			if len(toks) >= 9 {
				if _, err := strconv.Atoi(toks[8]); err != nil {
					return g, fmt.Errorf("line %d: bad rotation: %v", lineNo, err)
				}
			}
			g.Maps[cur].Boxes = append(g.Maps[cur].Boxes, box)
		case "edge":
			if len(toks) < 3 {
				return g, fmt.Errorf("line %d: edge needs from to", lineNo)
			}
			fromID, fromH := splitEndpoint(toks[1])
			toID, toH := splitEndpoint(toks[2])
			edge := Edge{From: fromID, FromHandle: fromH, To: toID, ToHandle: toH}
			if len(toks) >= 4 {
				palette, err := strconv.Atoi(toks[3])
				if err != nil {
					return g, fmt.Errorf("line %d: bad edge palette: %v", lineNo, err)
				}
				if palette >= 2 && palette <= 9 {
					edge.Palette = palette
				}
			}
			g.Maps[cur].Edges = append(g.Maps[cur].Edges, edge)
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
			ln := Line{ID: toks[1], X1: coords[0], Y1: coords[1], X2: coords[2], Y2: coords[3]}
			if len(toks) >= 7 {
				palette, err := strconv.Atoi(toks[6])
				if err != nil {
					return g, fmt.Errorf("line %d: bad line palette: %v", lineNo, err)
				}
				if palette >= 2 && palette <= 9 {
					ln.Palette = palette
				}
			}
			// Optional mid control points after the palette slot. Palette
			// is position-required when mids are present; value 1 is the
			// no-palette sentinel (already ignored by the check above).
			// Mids are emitted in (x, y) pairs.
			if len(toks) > 7 {
				if (len(toks)-7)%2 != 0 {
					return g, fmt.Errorf("line %d: line mids need pairs of coords", lineNo)
				}
				for i := 7; i < len(toks); i += 2 {
					mx, err := strconv.ParseFloat(toks[i], 64)
					if err != nil {
						return g, fmt.Errorf("line %d: bad line mid x: %v", lineNo, err)
					}
					my, err := strconv.ParseFloat(toks[i+1], 64)
					if err != nil {
						return g, fmt.Errorf("line %d: bad line mid y: %v", lineNo, err)
					}
					ln.Mids = append(ln.Mids, []float64{mx, my})
				}
			}
			g.Maps[cur].Lines = append(g.Maps[cur].Lines, ln)
		case "linestyle":
			if len(toks) < 3 {
				return g, fmt.Errorf("line %d: linestyle needs id and style", lineNo)
			}
			styleVal, err := strconv.Atoi(toks[2])
			if err != nil {
				return g, fmt.Errorf("line %d: bad linestyle: %v", lineNo, err)
			}
			if styleVal < 2 || styleVal > 9 {
				// 0 and 1 mean default (straight); ignore so the field
				// stays at the zero value rather than carrying garbage.
				break
			}
			found := false
			for i := range g.Maps[cur].Lines {
				if g.Maps[cur].Lines[i].ID == toks[1] {
					g.Maps[cur].Lines[i].Style = styleVal
					found = true
					break
				}
			}
			if !found {
				return g, fmt.Errorf("line %d: linestyle refers to unknown line %q", lineNo, toks[1])
			}
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
//
// When g.Version is non-empty, a `version <semver>` directive is
// emitted as the first line so consumers (older flowgo binaries, tools)
// can detect what wrote the file. Callers stamp the field at save time.
func Serialize(g Graph) string {
	var b strings.Builder
	if g.Version != "" {
		fmt.Fprintf(&b, "version %s\n", g.Version)
	}
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
			emitPalette := box.Palette >= 2 && box.Palette <= 9
			emitFont := box.Font >= 2 && box.Font <= 9
			fmt.Fprintf(&b, "box %s %s %g %g", box.ID, quote(box.Label), box.X, box.Y)
			// The "4" placeholder fills the vestigial sides slot when
			// palette/font follow, so old files like `box b1 hi 0 0 4 5`
			// round-trip positionally.
			if emitPalette || emitFont {
				fmt.Fprintf(&b, " 4")
			}
			if emitPalette || emitFont {
				palette := box.Palette
				if !emitPalette {
					palette = 1
				}
				fmt.Fprintf(&b, " %d", palette)
			}
			if emitFont {
				fmt.Fprintf(&b, " %d", box.Font)
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
			fmt.Fprintf(&b, "edge %s %s", joinEndpoint(e.From, e.FromHandle), joinEndpoint(e.To, e.ToHandle))
			if e.Palette >= 2 && e.Palette <= 9 {
				fmt.Fprintf(&b, " %d", e.Palette)
			}
			b.WriteString("\n")
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
			fmt.Fprintf(&b, "line %s %g %g %g %g", id, l.X1, l.Y1, l.X2, l.Y2)
			hasPal := l.Palette >= 2 && l.Palette <= 9
			if hasPal || len(l.Mids) > 0 {
				palTok := 1
				if hasPal {
					palTok = l.Palette
				}
				fmt.Fprintf(&b, " %d", palTok)
			}
			for _, m := range l.Mids {
				if len(m) < 2 {
					continue
				}
				fmt.Fprintf(&b, " %g %g", m[0], m[1])
			}
			b.WriteString("\n")
		}
		// linestyle directives follow the line block so older flowgo
		// binaries unaware of styles still parse the geometry cleanly.
		for _, l := range m.Lines {
			if l.Style >= 2 && l.Style <= 9 {
				fmt.Fprintf(&b, "linestyle %s %d\n", l.ID, l.Style)
			}
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
