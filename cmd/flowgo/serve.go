package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/lassediercks/flowgo/pkg/flowgo"
)

type serveConfig struct {
	BindAddr      string
	WebhookURL    string
	WebhookSecret string
	WorkspaceTTL  time.Duration
}

func runServe(args []string) {
	cfg := &serveConfig{
		BindAddr:     "127.0.0.1:8080",
		WorkspaceTTL: time.Hour,
	}

	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--bind":
			i++
			if i >= len(args) {
				die("--bind requires a value")
			}
			cfg.BindAddr = args[i]
		case strings.HasPrefix(a, "--bind="):
			cfg.BindAddr = strings.TrimPrefix(a, "--bind=")
		case a == "--share-webhook":
			i++
			if i >= len(args) {
				die("--share-webhook requires a value")
			}
			cfg.WebhookURL = args[i]
		case strings.HasPrefix(a, "--share-webhook="):
			cfg.WebhookURL = strings.TrimPrefix(a, "--share-webhook=")
		case a == "--share-webhook-secret":
			i++
			if i >= len(args) {
				die("--share-webhook-secret requires a value")
			}
			cfg.WebhookSecret = args[i]
		case strings.HasPrefix(a, "--share-webhook-secret="):
			cfg.WebhookSecret = strings.TrimPrefix(a, "--share-webhook-secret=")
		case a == "--workspace-ttl":
			i++
			if i >= len(args) {
				die("--workspace-ttl requires a value")
			}
			d, err := time.ParseDuration(args[i])
			if err != nil {
				die("--workspace-ttl: %v", err)
			}
			cfg.WorkspaceTTL = d
		case strings.HasPrefix(a, "--workspace-ttl="):
			d, err := time.ParseDuration(strings.TrimPrefix(a, "--workspace-ttl="))
			if err != nil {
				die("--workspace-ttl: %v", err)
			}
			cfg.WorkspaceTTL = d
		case a == "-h", a == "--help":
			printServeUsage(os.Stdout)
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown flag: %s\n", a)
			printServeUsage(os.Stderr)
			os.Exit(1)
		}
	}

	if cfg.WebhookSecret == "" {
		cfg.WebhookSecret = os.Getenv("FLOWGO_WEBHOOK_SECRET")
	}

	flowgo.Configure(flowgo.Config{
		ServeMode:          true,
		Workspaces:         flowgo.NewWorkspaceManager(cfg.WorkspaceTTL),
		ShareWebhookURL:    cfg.WebhookURL,
		ShareWebhookSecret: cfg.WebhookSecret,
		Version:            resolveVersionString,
	})

	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", flowgo.MCPHandler)
	mux.HandleFunc("/m/", func(w http.ResponseWriter, r *http.Request) {
		// Editor HTML for shared snapshots. The website reverse-proxies
		// /m/* here. The HTML detects snapshot mode from the pathname
		// and bootstraps from /api/snapshot/<id>.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(flowgo.IndexHTML))
	})
	mux.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, resolveVersionString())
	})

	ln, err := net.Listen("tcp", cfg.BindAddr)
	if err != nil {
		die("listen %s: %v", cfg.BindAddr, err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	fmt.Printf("flowgo serve\n")
	fmt.Printf("  bind:          %s (port %d)\n", cfg.BindAddr, addr.Port)
	fmt.Printf("  workspace ttl: %s\n", cfg.WorkspaceTTL)
	if cfg.WebhookURL != "" {
		fmt.Printf("  share webhook: %s\n", cfg.WebhookURL)
		if cfg.WebhookSecret != "" {
			fmt.Printf("  share auth:    Bearer (set)\n")
		} else {
			fmt.Printf("  share auth:    none\n")
		}
	} else {
		fmt.Printf("  share:         DISABLED (--share-webhook not set; agents calling share will fail)\n")
	}
	fmt.Printf("  routes:\n")
	fmt.Printf("    POST /mcp        → MCP JSON-RPC (workspaces + tools)\n")
	fmt.Printf("    GET  /m/<id>     → editor HTML (bootstraps from /api/snapshot/<id>)\n")
	fmt.Printf("    GET  /version    → %s\n", resolveVersionString())
	fmt.Println()
	if err := http.Serve(ln, mux); err != nil {
		die("serve: %v", err)
	}
}

func printServeUsage(w *os.File) {
	fmt.Fprintf(w, `flowgo serve — public mode (multi-workspace MCP + share-via-webhook)

Usage:
  flowgo serve [flags]

Flags:
  --bind <host:port>              listen address (default 127.0.0.1:8080)
  --share-webhook <url>           POST target for the 'share' MCP tool
                                  (the website's /api/snapshot endpoint)
  --share-webhook-secret <s>      bearer token sent on the webhook (or env
                                  FLOWGO_WEBHOOK_SECRET)
  --workspace-ttl <duration>      idle TTL for workspaces, e.g. 1h, 30m
                                  (default 1h)

The website reverse-proxies /api/mcp* and /m/* to this binary on loopback;
flowgo never serves the public surface directly.
`)
}
