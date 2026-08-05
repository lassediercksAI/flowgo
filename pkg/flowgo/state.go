// Package flowgo is the library form of the flowgo editor server. It
// exposes the embedded editor bundle, the MCP HTTP handler, and the
// in-memory Workspace manager so consumers can wire flowgo's
// behaviour onto their own HTTP mux without copying code. The CLI
// binary in cmd/flowgo is the canonical consumer.
//
// The package is configured once per process via Configure. The MCP
// handler is exposed as MCPHandler and reads state through the
// configured Backend (single-file or multi-tenant workspace).
package flowgo

import (
	_ "embed"
	"net/http"
	"sync"

	"github.com/lassediercks/flowgo/pkg/graph"
)

// Type aliases keep the rest of this package (and tests written before
// the package extraction) compiling without the `graph.` qualifier on
// every reference. External consumers should import pkg/graph directly.
type (
	Box      = graph.Box
	Edge     = graph.Edge
	Text     = graph.Text
	Line     = graph.Line
	Stroke   = graph.Stroke
	NamedMap = graph.NamedMap
	Graph    = graph.Graph
)

// parse / serialize / validate are kept as package-level shorthands for
// the same reason as the type aliases above.
var (
	parse         = graph.Parse
	serialize     = graph.Serialize
	validateGraph = graph.Validate
)

// IndexHTML is the embedded single-file editor bundle. Consumers serve
// it at "/" (and at "/m/<id>" for snapshot mode).
//
//go:embed dist/index.html
var IndexHTML string

// Config holds the per-process configuration for the MCP handler and
// any helpers that need to know whether we're in single-file or
// multi-tenant mode. Configure must be called before MCPHandler serves
// any request.
type Config struct {
	// ServeMode flips dispatch and tool listing into multi-tenant
	// workspace mode. When false, MCP reads/writes the single .flowgo
	// file at LocalFile.
	ServeMode bool

	// LocalFile is the on-disk .flowgo path (single-file mode only).
	LocalFile string
	// LocalFileMu serializes reads and writes against LocalFile. If nil
	// when ServeMode is false, Configure allocates one.
	LocalFileMu *sync.Mutex

	// Workspaces is the in-memory workspace store (serve mode only).
	Workspaces *WorkspaceManager

	// ShareWebhookURL is the POST target for the `share` MCP tool. Empty
	// disables `share` (the tool still appears in tools/list but returns
	// an error if called).
	ShareWebhookURL    string
	ShareWebhookSecret string

	// Auth links MCP sessions to host accounts (see mcpauth.go). Nil —
	// the default, and the only option for the CLI — keeps every MCP
	// session anonymous and hides the `authenticate` tool.
	Auth MCPAuth

	// Version returns the version string to stamp into serialized graphs
	// and to report in initialize / serverInfo. If nil, "dev" is used.
	Version func() string
}

var cfg Config

// init seeds cfg with safe defaults so the package can be imported and
// metadata-only MCP requests (initialize, tools/list, resources/list,
// resources/read) work without a Configure call. Tests rely on this.
func init() {
	cfg = Config{Version: func() string { return "dev" }}
}

// Configure sets the package-level configuration. Safe to call before
// any handler serves a request; not safe to call concurrently with
// active MCP traffic.
func Configure(c Config) {
	if c.Version == nil {
		c.Version = func() string { return "dev" }
	}
	if !c.ServeMode && c.LocalFileMu == nil {
		c.LocalFileMu = &sync.Mutex{}
	}
	cfg = c
	// The parsed-file cache (localfile.go) is keyed to cfg.LocalFile;
	// re-configuring may point at a different file, so start cold.
	resetLocalCacheLocked()
}

// MCPHandler is the JSON-RPC MCP HTTP handler. Configure must run first.
func MCPHandler(w http.ResponseWriter, r *http.Request) {
	handleMCP(w, r)
}
