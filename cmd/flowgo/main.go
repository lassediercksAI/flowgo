// Package main is the public flowgo CLI. It composes the
// pkg/flowgo library with a small flag parser, browser launcher, and
// version reporter; everything substantive lives in the library so
// downstream consumers can wire flowgo onto their own HTTP mux
// without copying code.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"

	"github.com/lassediercks/flowgo/pkg/flowgo"
	"github.com/lassediercks/flowgo/pkg/graph"
)

// version is overwritten at release-build time via:
//
//	go build -ldflags "-X main.version=<tag>" ./cmd/flowgo
//
// `go install ...@<tag>` also surfaces the module version via
// runtime/debug, which resolveVersionString falls back on.
var version = "dev"

var (
	fileMu   sync.Mutex
	filePath string
	mediaMu  sync.Mutex
)

// mediaDirName is the sibling folder (next to the .flowgo file) that
// holds pasted/dropped image assets. It's also the URL prefix the
// editor references images by, so the on-disk layout and the relative
// `src` in the .flowgo file line up.
const mediaDirName = "flowgo-media"

// mediaExtByType maps accepted image content-types to the file
// extension used for content-addressed storage. Anything not listed is
// rejected — we don't want to write arbitrary uploaded bytes to disk.
var mediaExtByType = map[string]string{
	"image/png":     ".png",
	"image/jpeg":    ".jpg",
	"image/gif":     ".gif",
	"image/webp":    ".webp",
	"image/svg+xml": ".svg",
}

// mediaTypeByExt is the reverse map, used to set Content-Type when
// serving a stored asset back.
var mediaTypeByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
}

func mediaDir() string {
	return filepath.Join(filepath.Dir(filePath), mediaDirName)
}

func main() {
	if len(os.Args) < 2 {
		printUsage(os.Stderr)
		os.Exit(1)
	}
	switch os.Args[1] {
	case "serve":
		runServe(os.Args[2:])
		return
	case "upgrade":
		runUpgrade(os.Args[2:])
		return
	}
	bindHost := "127.0.0.1"
	useRandomName := false
	var positional []string
	for _, a := range os.Args[1:] {
		switch a {
		case "version", "-v", "--version":
			printVersion(os.Stdout)
			return
		case "help", "-h", "--help":
			printUsage(os.Stdout)
			return
		case "new":
			useRandomName = true
		case "--host":
			bindHost = "0.0.0.0"
		default:
			if strings.HasPrefix(a, "-") {
				fmt.Fprintf(os.Stderr, "unknown flag: %s\n", a)
				os.Exit(1)
			}
			positional = append(positional, a)
		}
	}
	switch {
	case useRandomName:
		filePath = randomMapName() + ".flowgo"
		for i := 0; i < 5; i++ {
			if _, err := os.Stat(filePath); os.IsNotExist(err) {
				break
			}
			filePath = randomMapName() + ".flowgo"
		}
	case len(positional) >= 1:
		filePath = positional[0]
		if !strings.HasSuffix(filePath, ".flowgo") {
			filePath += ".flowgo"
		}
	default:
		printUsage(os.Stderr)
		os.Exit(1)
	}

	createdFile := false
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		seed := graph.Serialize(graph.Graph{
			Version: resolveVersionString(),
			Maps: []graph.NamedMap{{
				Path:  "/",
				Boxes: []graph.Box{{ID: "b1", Label: seedBoxLabel(filePath)}},
			}},
		})
		if err := os.WriteFile(filePath, []byte(seed), 0644); err != nil {
			die("create file: %v", err)
		}
		createdFile = true
	}
	if createdFile {
		fmt.Printf("initialised the flowgo interface on a new file %s\n", filePath)
	}

	flowgo.Configure(flowgo.Config{
		ServeMode:   false,
		LocalFile:   filePath,
		LocalFileMu: &fileMu,
		Version:     resolveVersionString,
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// No-store: the editor bundle is embedded at build time, so a
		// browser that heuristically caches this page (no cache headers
		// = cache at the browser's discretion) keeps serving the OLD
		// editor after the binary is upgraded or the dev loop restarts
		// — new features then look broken until a hard reload. The
		// page is served from memory; re-sending it costs nothing.
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(flowgo.IndexHTML))
	})
	http.HandleFunc("/state", handleState)
	http.HandleFunc("/save", handleSave)
	http.HandleFunc("/media", handleMediaUpload)
	http.HandleFunc("/"+mediaDirName+"/", handleMediaGet)
	http.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, resolveVersionString())
	})
	http.HandleFunc("/mcp", flowgo.MCPHandler)

	// Walk forward from the canonical port so a second flowgo (or any
	// process holding 54041) doesn't fail to start. Range is bounded to
	// keep collisions visible in URLs rather than scattering across
	// ephemeral space.
	ln, err := listenFirstFree(bindHost, 54041, 54099)
	if err != nil {
		die("listen on %s:54041-54099: %v", bindHost, err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	displayHost := bindHost
	if bindHost == "0.0.0.0" {
		if lan := pickLanIP(); lan != "" {
			displayHost = lan
		}
	}
	// FLOWGO_DISPLAY_HOST overrides the host portion of the printed
	// URL without affecting where the server actually binds. Useful
	// when the LAN IP picked from inside a container is the Docker
	// bridge address (e.g. 192.168.165.2) — unreachable from the
	// host — and the dev image wants to point users at the
	// port-forwarded "localhost" instead.
	if v := os.Getenv("FLOWGO_DISPLAY_HOST"); v != "" {
		displayHost = v
	}
	url := fmt.Sprintf("http://%s:%d", displayHost, addr.Port)
	fmt.Printf("flowgo editing %s\n  GUI: %s\n  MCP: %s/mcp\n", filePath, url, url)
	if bindHost == "127.0.0.1" && os.Getenv("FLOWGO_NO_OPEN") == "" {
		openBrowser(url)
	} else if bindHost != "127.0.0.1" && !isLocalhostHost(displayHost) {
		fmt.Printf("  (also reachable on http://localhost:%d from this machine)\n", addr.Port)
	}
	maybeNotifyNewVersion()
	if err := http.Serve(ln, nil); err != nil {
		die("serve: %v", err)
	}
}

// isLocalhostHost reports whether the display host is one of the
// loopback aliases the "(also reachable on localhost…)" hint would
// just repeat. Keeps the redundant line suppressed when callers set
// FLOWGO_DISPLAY_HOST to any of localhost / 127.0.0.1 / ::1.
func isLocalhostHost(h string) bool {
	switch h {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

// pickLanIP returns a usable IPv4 from this host's interfaces, preferring
// RFC 1918 private ranges (10/8, 172.16/12, 192.168/16) over any other
// non-loopback IPv4. Empty string when nothing usable is reachable —
// callers should fall back to bindHost in that case.
func pickLanIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	return pickLanIPFromAddrs(addrs)
}

func pickLanIPFromAddrs(addrs []net.Addr) string {
	var fallback string
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip4 := ipnet.IP.To4()
		if ip4 == nil {
			continue
		}
		if ip4.IsLoopback() || ip4.IsLinkLocalUnicast() || ip4.IsUnspecified() {
			continue
		}
		if ip4.IsPrivate() {
			return ip4.String()
		}
		if fallback == "" {
			fallback = ip4.String()
		}
	}
	return fallback
}

// listenFirstFree tries each port in [start, end] on host and returns the
// first listener that binds successfully.
func listenFirstFree(host string, start, end int) (net.Listener, error) {
	var lastErr error
	for port := start; port <= end; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
		if err == nil {
			return ln, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func handleState(w http.ResponseWriter, r *http.Request) {
	fileMu.Lock()
	defer fileMu.Unlock()
	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	g, err := graph.Parse(string(data))
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(g)
}

func handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}
	var g graph.Graph
	if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	fileMu.Lock()
	defer fileMu.Unlock()
	g.Version = resolveVersionString()
	if err := os.WriteFile(filePath, []byte(graph.Serialize(g)), 0644); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(204)
}

// maxMediaBytes caps a single uploaded asset. Images beyond this are
// rejected rather than silently written — a mind-map isn't a photo
// library, and huge inlined assets bloat the working directory.
const maxMediaBytes = 25 << 20 // 25 MiB

// handleMediaUpload accepts a raw image body (Content-Type set to the
// image MIME) and writes it into the flowgo-media/ folder under a
// content-addressed name: sha256(bytes)[:16] + ext. Identical uploads
// collapse to one file (dedup). Responds {"src":"flowgo-media/<name>"}
// — the relative path the editor stores in the .flowgo file.
func handleMediaUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}
	ct := r.Header.Get("Content-Type")
	// Strip any "; charset=..." parameter before the map lookup.
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	ext, ok := mediaExtByType[ct]
	if !ok {
		http.Error(w, "unsupported image type: "+ct, http.StatusUnsupportedMediaType)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxMediaBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusRequestEntityTooLarge)
		return
	}
	if len(data) == 0 {
		http.Error(w, "empty body", 400)
		return
	}
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:])[:16] + ext

	mediaMu.Lock()
	defer mediaMu.Unlock()
	dir := mediaDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, "mkdir media: "+err.Error(), 500)
		return
	}
	dst := filepath.Join(dir, name)
	if _, err := os.Stat(dst); os.IsNotExist(err) {
		if err := os.WriteFile(dst, data, 0644); err != nil {
			http.Error(w, "write media: "+err.Error(), 500)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"src": mediaDirName + "/" + name})
}

// handleMediaGet serves a stored asset. The filename is sanitized to a
// bare base name so a crafted path (../, absolute, nested) can't escape
// the media folder.
func handleMediaGet(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/"+mediaDirName+"/")
	// Reject anything that isn't a simple filename living directly in
	// the media folder — no separators, no traversal, no empties.
	if rest == "" || rest != filepath.Base(rest) || strings.Contains(rest, "..") {
		http.Error(w, "bad media path", 400)
		return
	}
	full := filepath.Join(mediaDir(), rest)
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if ct, ok := mediaTypeByExt[strings.ToLower(filepath.Ext(rest))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	// Content-addressed names are immutable, so caching is safe and cheap.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, rest, info.ModTime(), f)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}

func printUsage(w *os.File) {
	fmt.Fprintf(w, `flowgo — browser-based mind-map editor backed by a plain-text file.

Usage:
  flowgo <file.flowgo>             open the editor (binds 127.0.0.1 only)
  flowgo <name>                    open <name>.flowgo, creating it if missing
  flowgo new                       create a map with a random humanized name (e.g. solid_frontend.flowgo)
  flowgo <name|new> --host         bind 0.0.0.0 (reach from outside this machine/container)
  flowgo serve [flags]             public mode: multi-workspace MCP + share-via-webhook
                                   (run 'flowgo serve --help' for flags)
  flowgo upgrade                   download the latest release and replace this binary
  flowgo version                   print version info
  flowgo help                      show this message
`)
}

func resolveVersionString() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		if v := info.Main.Version; v != "" && v != "(devel)" {
			return strings.TrimPrefix(v, "v")
		}
	}
	return "dev"
}

func compactVersion() string {
	v := version
	var rev string
	dirty := false
	if info, ok := debug.ReadBuildInfo(); ok {
		if v == "dev" && info.Main.Version != "" && info.Main.Version != "(devel)" {
			v = info.Main.Version
		}
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				if len(s.Value) > 12 {
					rev = s.Value[:12]
				} else {
					rev = s.Value
				}
			case "vcs.modified":
				if s.Value == "true" {
					dirty = true
				}
			}
		}
	}
	if rev == "" {
		return v
	}
	suffix := ""
	if dirty {
		suffix = "+dirty"
	}
	return v + " (" + rev + suffix + ")"
}

func printVersion(w *os.File) {
	v := resolveVersionString()
	var rev, when string
	modified := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.time":
				when = s.Value
			case "vcs.modified":
				if s.Value == "true" {
					modified = "+dirty"
				}
			}
		}
	}
	fmt.Fprintf(w, "flowgo %s", v)
	if rev != "" {
		short := rev
		if len(short) > 12 {
			short = short[:12]
		}
		fmt.Fprintf(w, " (%s%s", short, modified)
		if when != "" {
			fmt.Fprintf(w, ", %s", when)
		}
		fmt.Fprintf(w, ")")
	}
	fmt.Fprintln(w)
}
