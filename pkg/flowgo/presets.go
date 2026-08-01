// Embedded starter presets. A preset is a complete .flowgo document
// baked into the binary; `flowgo <name> --preset <preset>` seeds a
// NEW map file from one instead of the default single-box seed.
//
// The files under presets/ are the canonical copies — add a new
// preset by dropping a .flowgo file there (it is embedded and listed
// automatically; the test suite asserts every embedded preset parses,
// so a malformed file fails CI rather than a user's first run).
package flowgo

import (
	"embed"
	"sort"
	"strings"
)

//go:embed presets/*.flowgo
var presetsFS embed.FS

// PresetNames returns the embedded preset names (file base names
// without the .flowgo suffix), sorted for stable help output.
func PresetNames() []string {
	entries, err := presetsFS.ReadDir("presets")
	if err != nil {
		// Embedded FS reads can only fail on a broken build; an empty
		// list degrades to "no presets available".
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, strings.TrimSuffix(e.Name(), ".flowgo"))
	}
	sort.Strings(names)
	return names
}

// Preset returns the raw .flowgo text of the named preset. The bool
// reports whether the name exists.
func Preset(name string) (string, bool) {
	b, err := presetsFS.ReadFile("presets/" + name + ".flowgo")
	if err != nil {
		return "", false
	}
	return string(b), true
}
