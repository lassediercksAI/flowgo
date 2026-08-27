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
// graphs as JSON. (The Go type keeps its historical Box name — the
// text format's canonical directive is `node`, with `box` as the
// deprecated legacy spelling; renaming the public type would break
// downstream consumers for no wire-level gain.)
//
// The `.flowgo` text format keeps a vestigial "sides" slot between
// the y coordinate and the palette token (always emitted as 4) so old
// node directives like `node b1 hi 0 0 3 5` still parse positionally —
// the polygon feature is gone, but the wire layout is preserved.
type Box struct {
	ID      string  `json:"id"`
	Label   string  `json:"label"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Palette int     `json:"palette,omitempty"`
	Font    int     `json:"font,omitempty"`
	// Anchor marks this node as the map-level recenter target. At most
	// one node per map carries Anchor=true; the parser/serializer enforce
	// the invariant. Persisted in the .flowgo text format as a separate
	// per-map `anchor <id>` directive rather than a positional token.
	Anchor bool `json:"anchor,omitempty"`
	// W/H, when both > 0, pin the node to an explicit on-canvas size in
	// data pixels (the user resized it in the editor). Zero means
	// auto-size: the node hugs its label like it always has. Persisted
	// as a separate `nodesize <id> <w> <h>` directive (legacy spelling
	// `boxsize` still parses) — the positional slots on the `node`
	// line are all claimed by back-compat baggage.
	// Ignored for special shapes (Shape!=0), which have fixed sizes.
	W float64 `json:"w,omitempty"`
	H float64 `json:"h,omitempty"`
	// Shape selects the render silhouette: 0 (default) is the classic
	// auto-sized rectangle, 1 hexagon, 2 circle, 3 triangle (all fixed
	// uniform size, never resizable; hexagons additionally lattice-
	// snap). 4-9 are reserved. Persisted as a separate
	// `nodeshape <id> <shape>` directive after the node block (legacy
	// spelling `boxshape` still parses) — the positional slots on the
	// `node` line are all claimed by back-compat baggage (mirrors the
	// linestyle precedent for lines).
	Shape int `json:"shape,omitempty"`
}

// Edge connects two nodes within the same map.
type Edge struct {
	From       string `json:"from"`
	FromHandle string `json:"fromHandle,omitempty"`
	To         string `json:"to"`
	ToHandle   string `json:"toHandle,omitempty"`
	Palette    int    `json:"palette,omitempty"`
	// Label is the text drawn at the edge midpoint — "depends on",
	// "triggers", "owns". Empty means unlabelled.
	//
	// Persisted as the FIFTH positional token on the `edge` line,
	// after the palette: `edge <from> <to> <palette> <label>`. It has
	// to go after, not before: slot 4 has been the optional palette
	// since the format existed, and Parse reads it with strconv.Atoi,
	// so a label there would either be misread as a palette (label
	// "3") or hard-error every existing reader. A label therefore
	// forces a palette token to be emitted; when the edge has no
	// palette of its own the default sentinel `1` fills the slot,
	// exactly like the `line` directive does to park its mid
	// coordinates in a stable position. Parse ignores palette 1.
	//
	// Unlabelled edges emit no extra token at all, so every document
	// written before edge labels existed keeps its exact bytes.
	//
	// Compatibility (measured against 0.3.12, not assumed): older
	// binaries do NOT reject the five-token line — their edge case
	// stops reading after the palette — so an old flowgo opens a
	// labelled map fine. It drops the labels when it next WRITES the
	// file. Gentler than the `defaultshape` break in #208, but still
	// one-way: don't round-trip a labelled map through an old binary.
	//
	// Unlike a node, an edge has no id, and the .flowgo format does
	// not stop a hand-written file from carrying two `edge a b` lines
	// — so a side-table directive (the `nodesize` / `nodeshape`
	// pattern) could not say WHICH edge it labelled. The positional
	// token has no such ambiguity.
	Label string `json:"label,omitempty"`
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

// Image is a raster asset placed on a map. Src is a path relative to
// the .flowgo file (e.g. "flowgo-media/<hash>.png"); the binary lives
// in the flowgo-media/ sibling folder, never inline in the text file.
// Width/Height are the on-canvas display size in data pixels.
type Image struct {
	ID     string  `json:"id"`
	Src    string  `json:"src"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// NamedMap is one canvas at a given path. Submap paths are slash-
// separated node ids: "/A/B" hangs off node A on "/" and node B on "/A".
type NamedMap struct {
	Path    string   `json:"path"`
	Boxes   []Box    `json:"boxes"`
	Edges   []Edge   `json:"edges"`
	Texts   []Text   `json:"texts,omitempty"`
	Lines   []Line   `json:"lines,omitempty"`
	Strokes []Stroke `json:"strokes,omitempty"`
	Images  []Image  `json:"images,omitempty"`
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
	// DefaultShape records the shape a canvas double-click creates in
	// this document: 0 (absent) rectangle, 1 hexagon, 2 circle,
	// 3 triangle. Persisted as a document-level `defaultshape <n>`
	// directive right after `version`; zero is never emitted. The
	// legacy `hexagons on` directive still parses (as DefaultShape=1)
	// but is no longer written — the per-browser hexagon setting it
	// backed was retired in favour of this per-file default.
	DefaultShape int `json:"defaultShape,omitempty"`
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
	// bufio.Scanner defaults to a 64KiB max token (line) size with no
	// Buffer() call. That's reachable in practice — a single `stroke`
	// directive with enough freehand points, or a `line` with enough
	// mids, easily clears 64KiB — and the failure mode was bad on two
	// counts: sc.Err() returns bufio.ErrTooLong with no line number,
	// and every directive read before the oversized line stayed in g,
	// so the caller got a silently truncated graph back alongside the
	// error instead of nothing. raise the ceiling far past anything a
	// real map produces (src/graph/parse.ts, which this must match
	// byte-for-byte, has no line-length limit at all) and, below, turn
	// any remaining scan error into an atomic failure with a line
	// number instead of a partial graph.
	sc.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		toks := tokenize(line)
		// An empty leading token means the line opens with `""`, which
		// is not a directive. Skipping keeps such a line ignored exactly
		// as it was before tokenize learned to emit empty quoted values
		// — turning a previously-tolerated line into a hard parse error
		// would itself make files unopenable.
		if len(toks) == 0 || toks[0] == "" {
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
		case "hexagons":
			// Legacy document-level preference (pre-defaultshape files):
			// `hexagons on` meant "open with the hexagon setting
			// enabled" — today that maps to a hexagon default shape.
			// Bare `hexagons` counts as on. `off` is a no-op rather
			// than a reset so it can never clobber a defaultshape
			// directive regardless of line order. Never re-emitted:
			// serialization writes `defaultshape` instead.
			if len(toks) < 2 {
				if g.DefaultShape == 0 {
					g.DefaultShape = 1
				}
				break
			}
			switch toks[1] {
			case "on", "1", "true":
				if g.DefaultShape == 0 {
					g.DefaultShape = 1
				}
			case "off", "0", "false":
				// no-op
			default:
				return g, fmt.Errorf("line %d: hexagons wants on or off, got %q", lineNo, toks[1])
			}
		case "defaultshape":
			// Document-level default shape for new nodes: 1 hexagon,
			// 2 circle, 3 triangle (0 / rectangle is the absent
			// default and never emitted). Out-of-range values are
			// ignored rather than fatal, mirroring nodeshape, so a
			// future shape id degrades to "rectangle" instead of
			// locking the file out of older binaries at THIS version.
			if len(toks) < 2 {
				return g, fmt.Errorf("line %d: defaultshape needs a value", lineNo)
			}
			shapeVal, err := strconv.Atoi(toks[1])
			if err != nil {
				return g, fmt.Errorf("line %d: bad defaultshape: %v", lineNo, err)
			}
			if shapeVal >= 1 && shapeVal <= 9 {
				g.DefaultShape = shapeVal
			}
		case "map":
			if len(toks) < 2 {
				return g, fmt.Errorf("line %d: map needs path", lineNo)
			}
			cur = findOrCreate(toks[1])
		case "node", "box":
			// `node` is the canonical directive; `box` is the legacy
			// spelling — keep parsing it until at least v0.5.x. Files
			// may mix both forms (half-migrated files must open).
			// Serialization always emits `node`.
			if len(toks) < 5 {
				return g, fmt.Errorf("line %d: %s needs id label x y", lineNo, toks[0])
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
			// Slot 5 is the edge label (see Edge.Label). It sits after
			// the palette because slot 4 was already claimed; a label
			// on an otherwise-unstyled edge is written with the
			// palette sentinel 1 in front of it.
			if len(toks) >= 5 {
				edge.Label = toks[4]
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
		case "nodesize", "boxsize":
			// `boxsize` is the legacy spelling — parse-only alias, keep
			// until at least v0.5.x. Serialization emits `nodesize`.
			if len(toks) < 4 {
				return g, fmt.Errorf("line %d: %s needs id, width, and height", lineNo, toks[0])
			}
			bw, err := strconv.ParseFloat(toks[2], 64)
			if err != nil {
				return g, fmt.Errorf("line %d: bad %s width: %v", lineNo, toks[0], err)
			}
			bh, err := strconv.ParseFloat(toks[3], 64)
			if err != nil {
				return g, fmt.Errorf("line %d: bad %s height: %v", lineNo, toks[0], err)
			}
			if bw <= 0 || bh <= 0 {
				// Non-positive dims mean auto-size; ignore rather than
				// carry garbage (mirrors linestyle's out-of-range skip).
				break
			}
			foundSizeBox := false
			for i := range g.Maps[cur].Boxes {
				if g.Maps[cur].Boxes[i].ID == toks[1] {
					g.Maps[cur].Boxes[i].W = bw
					g.Maps[cur].Boxes[i].H = bh
					foundSizeBox = true
					break
				}
			}
			if !foundSizeBox {
				return g, fmt.Errorf("line %d: %s refers to unknown node %q", lineNo, toks[0], toks[1])
			}
		case "nodeshape", "boxshape":
			// `boxshape` is the legacy spelling — parse-only alias, keep
			// until at least v0.5.x. Serialization emits `nodeshape`.
			if len(toks) < 3 {
				return g, fmt.Errorf("line %d: %s needs id and shape", lineNo, toks[0])
			}
			shapeVal, err := strconv.Atoi(toks[2])
			if err != nil {
				return g, fmt.Errorf("line %d: bad %s: %v", lineNo, toks[0], err)
			}
			if shapeVal < 1 || shapeVal > 9 {
				// 0 means default (rectangle); ignore so the field stays
				// at the zero value rather than carrying garbage.
				break
			}
			foundBox := false
			for i := range g.Maps[cur].Boxes {
				if g.Maps[cur].Boxes[i].ID == toks[1] {
					g.Maps[cur].Boxes[i].Shape = shapeVal
					foundBox = true
					break
				}
			}
			if !foundBox {
				return g, fmt.Errorf("line %d: %s refers to unknown node %q", lineNo, toks[0], toks[1])
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
				return g, fmt.Errorf("line %d: anchor refers to unknown node %q", lineNo, id)
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
		case "image":
			if len(toks) < 7 {
				return g, fmt.Errorf("line %d: image needs id src x y width height", lineNo)
			}
			coords := make([]float64, 4)
			for i, t := range toks[3:7] {
				v, err := strconv.ParseFloat(t, 64)
				if err != nil {
					return g, fmt.Errorf("line %d: bad image coord: %v", lineNo, err)
				}
				coords[i] = v
			}
			g.Maps[cur].Images = append(g.Maps[cur].Images, Image{
				ID:     toks[1],
				Src:    toks[2],
				X:      coords[0],
				Y:      coords[1],
				Width:  coords[2],
				Height: coords[3],
			})
		default:
			return g, fmt.Errorf("line %d: unknown directive %q", lineNo, toks[0])
		}
	}
	if err := sc.Err(); err != nil {
		// Atomic failure: never hand back a graph that silently dropped
		// everything from the oversized/unreadable line onward. lineNo
		// is the count of lines successfully scanned before the error,
		// so the failing line is the next one.
		return Graph{}, fmt.Errorf("line %d: %w", lineNo+1, err)
	}
	return g, nil
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
		// Quoted like any other free-text value: an unquoted version
		// containing a space (or any other tokenizer-significant
		// character) would split into extra tokens on the way back in,
		// silently truncating Graph.Version to its first word. quote()
		// is a no-op for the common case (a bare semver string), so
		// every existing file's first line is untouched.
		fmt.Fprintf(&b, "version %s\n", quote(g.Version))
	}
	// Document default shape: emitted only when set, directly after
	// version (the slot the legacy `hexagons on` used to occupy).
	// Part of the byte-parity contract with the TS serializer.
	if g.DefaultShape >= 1 && g.DefaultShape <= 9 {
		fmt.Fprintf(&b, "defaultshape %d\n", g.DefaultShape)
	}
	var nonEmpty []NamedMap
	for _, m := range g.Maps {
		if len(m.Boxes) == 0 && len(m.Edges) == 0 && len(m.Texts) == 0 && len(m.Lines) == 0 && len(m.Strokes) == 0 && len(m.Images) == 0 {
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
			fmt.Fprintf(&b, "map %s\n", quoteID(m.Path))
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
		for _, x := range m.Images {
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
			fmt.Fprintf(&b, "node %s %s %s %s", quoteID(box.ID), quote(box.Label), jsNumberString(box.X), jsNumberString(box.Y))
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
		// nodesize then nodeshape directives follow the node block (like
		// linestyle after lines) so parsers see the node before its
		// annotations. Emit order is part of the byte-parity contract
		// with src/graph/serialize.ts — keep the two in sync.
		for _, box := range m.Boxes {
			if box.W > 0 && box.H > 0 {
				fmt.Fprintf(&b, "nodesize %s %s %s\n", quoteID(box.ID), jsNumberString(box.W), jsNumberString(box.H))
			}
		}
		for _, box := range m.Boxes {
			if box.Shape >= 1 && box.Shape <= 9 {
				fmt.Fprintf(&b, "nodeshape %s %d\n", quoteID(box.ID), box.Shape)
			}
		}
		// Single-anchor invariant: emit at most one `anchor <id>` line.
		// First Anchor=true wins; later occurrences are ignored.
		for _, box := range m.Boxes {
			if box.Anchor {
				fmt.Fprintf(&b, "anchor %s\n", quoteID(box.ID))
				break
			}
		}
		if len(m.Boxes) > 0 && len(m.Edges) > 0 {
			b.WriteString("\n")
		}
		for _, e := range m.Edges {
			fmt.Fprintf(&b, "edge %s %s", joinEndpoint(e.From, e.FromHandle), joinEndpoint(e.To, e.ToHandle))
			emitEPalette := e.Palette >= 2 && e.Palette <= 9
			// A label needs the palette slot filled so it lands in a
			// stable position — sentinel 1 when the edge has none of
			// its own (the `line` mids precedent). An unlabelled,
			// unstyled edge emits neither token, so pre-label
			// documents are byte-for-byte unchanged.
			if emitEPalette || e.Label != "" {
				palette := e.Palette
				if !emitEPalette {
					palette = 1
				}
				fmt.Fprintf(&b, " %d", palette)
			}
			if e.Label != "" {
				fmt.Fprintf(&b, " %s", quote(e.Label))
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
			fmt.Fprintf(&b, "text %s %s %s %s", quoteID(id), quote(t.Label), jsNumberString(t.X), jsNumberString(t.Y))
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
			fmt.Fprintf(&b, "line %s %s %s %s %s", quoteID(id), jsNumberString(l.X1), jsNumberString(l.Y1), jsNumberString(l.X2), jsNumberString(l.Y2))
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
				fmt.Fprintf(&b, " %s %s", jsNumberString(m[0]), jsNumberString(m[1]))
			}
			b.WriteString("\n")
		}
		// linestyle directives follow the line block so older flowgo
		// binaries unaware of styles still parse the geometry cleanly.
		for _, l := range m.Lines {
			if l.Style >= 2 && l.Style <= 9 {
				fmt.Fprintf(&b, "linestyle %s %d\n", quoteID(l.ID), l.Style)
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
			fmt.Fprintf(&b, "stroke %s", quoteID(id))
			if s.Palette >= 2 && s.Palette <= 9 {
				fmt.Fprintf(&b, " %d", s.Palette)
			}
			for _, p := range s.Points {
				if len(p) < 2 {
					continue
				}
				fmt.Fprintf(&b, " %s,%s", jsNumberString(p[0]), jsNumberString(p[1]))
			}
			b.WriteString("\n")
		}
		if (len(m.Boxes) > 0 || len(m.Edges) > 0 || len(m.Texts) > 0 || len(m.Lines) > 0 || len(m.Strokes) > 0) && len(m.Images) > 0 {
			b.WriteString("\n")
		}
		for _, img := range m.Images {
			id := img.ID
			if id == "" {
				id = fallbackID("img")
			}
			fmt.Fprintf(&b, "image %s %s %s %s %s %s", quoteID(id), quote(img.Src), jsNumberString(img.X), jsNumberString(img.Y), jsNumberString(img.Width), jsNumberString(img.Height))
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
	// quoted records that the token being accumulated opened a quote,
	// so an explicitly empty value survives. Without it `node b1 "" 0 0`
	// — what Serialize writes for a node with no label — tokenizes to
	// four tokens and the parser rejects the line, which bricks the
	// whole file for every later read.
	quoted := false
	flush := func() {
		if cur.Len() > 0 || quoted {
			out = append(out, cur.String())
			cur.Reset()
			quoted = false
		}
	}
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
			quoted = true
		case !inQuote && (r == ' ' || r == '\t'):
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

func splitEndpoint(s string) (string, string) {
	if i := strings.Index(s, ":"); i >= 0 {
		return s[:i], s[i+1:]
	}
	return s, ""
}

// joinEndpoint renders an edge endpoint. The id is quoted when it
// would otherwise re-tokenize wrong; the handle is validated against a
// closed set (validHandle) so it never needs quoting. `"a b":t`
// tokenizes back to `a b:t`, which splitEndpoint reads correctly.
func joinEndpoint(id, handle string) string {
	if handle == "" {
		return quoteID(id)
	}
	return quoteID(id) + ":" + handle
}

// quoteReplacer escapes the characters that carry structure in the
// line-based .flowgo format. `\r` has no escape of its own and never
// gets one: the TypeScript parser (src/graph/parse.ts) splits input on
// /\r\n|\r|\n/, so a raw CR — quoted or not — cuts the directive in
// half there while Go's scanner keeps reading. Emitting it as the
// newline escape applies the same CR → LF folding NormalizeLabel does,
// which is the only reading of a CR both parsers can agree on. The
// `\r\n` pair must precede the bare `\r` so a CRLF collapses to one
// newline rather than two.
var quoteReplacer = strings.NewReplacer(
	"\\", "\\\\",
	"\"", "\\\"",
	"\n", "\\n",
	"\r\n", "\\n",
	"\r", "\\n",
)

func quote(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\n\r\"\\") {
		return "\"" + quoteReplacer.Replace(s) + "\""
	}
	return s
}

// quoteID is quote() applied to identifiers and map paths — same
// rules, named separately because the reason differs. Ids are supposed
// to be plain words and Validate rejects anything else on every write
// path, but Serialize is also reachable from callers that never
// validate (other repositories pin pkg/graph and hand it decoded
// JSON), and an unquoted id carrying a space or a newline splits its
// own directive into a line the parser rejects — which bricks the file
// for every later read, with no copy to fall back on. Quoting is a
// pure safety net: an id with no structural characters comes back
// byte-for-byte unchanged, so the on-disk bytes of every valid
// document are untouched.
//
// The one thing it cannot rescue is `:`, which survives quoting and
// still splits the endpoint in `edge a:t b`. That stays
// validation-only.
func quoteID(s string) string { return quote(s) }
