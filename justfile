# Dev tasks for flowgo.
#
# `just dev`  — rebuilds dist/index.html on TS/HTML edits (vite --watch)
#               and restarts the Go server on changes to dist/index.html
#               or any *.go file. No external watcher binary required;
#               the Go side is polled with stat + a 500ms sleep.
#
#               Binds 0.0.0.0 (--host) by default so other devices on the
#               LAN / containers can reach the dev server.
#
#               The first run opens the editor in your browser; subsequent
#               restarts set FLOWGO_NO_OPEN=1 so they reuse the existing tab
#               (just hit reload, or rely on the server reconnect).
#
# Requires: pnpm, go.

set shell := ["bash", "-cu"]

default_file := "map.flowgo"

default: dev

# Frontend (vite --watch) + Go (poll + restart on file change).
dev file=default_file:
    @command -v pnpm >/dev/null || { echo "pnpm not found — npm i -g pnpm"; exit 1; }
    @command -v go   >/dev/null || { echo "go not found";                    exit 1; }
    pnpm install --silent
    just _dev-run "{{file}}"

# Internal: vite --watch in the background, polling-loop runs go.
_dev-run file:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm exec vite build
    pnpm exec vite build --watch >/tmp/flowgo-vite.log 2>&1 &
    VITE_PID=$!
    GO_PID=
    # Touch a marker after each successful start; on each tick check
    # whether any *.go or dist/index.html is newer than the marker.
    # `-nt` is portable across bash on macOS (BSD) and Linux (GNU).
    marker=$(mktemp -t flowgo-dev.XXXXXX)
    cleanup() {
        [[ -n "${GO_PID}" ]] && kill "$GO_PID" 2>/dev/null || true
        [[ -n "${VITE_PID}" ]] && kill "$VITE_PID" 2>/dev/null || true
        GO_PID=
        VITE_PID=
        [[ -n "${marker}" ]] && rm -f "$marker" || true
    }
    # Trap EXIT for normal exits; trap INT/TERM separately and exit
    # explicitly so Ctrl+C tears down the polling loop. Without the
    # explicit `exit`, bash runs the handler and then resumes after
    # the interrupted `sleep`, which silently restarts `go run` on
    # the next tick (e.g. when vite finishes its in-flight rebuild
    # and updates dist/index.html post-INT).
    shutdown() {
        trap - INT TERM EXIT
        cleanup
        exit 130
    }
    trap cleanup EXIT
    trap shutdown INT TERM

    started=0
    start_go() {
        [[ -n "${GO_PID}" ]] && kill "$GO_PID" 2>/dev/null || true
        wait "$GO_PID" 2>/dev/null || true
        echo "── restarting flowgo ──────────────────────────────────"
        if (( started )); then
            FLOWGO_NO_OPEN=1 go run ./cmd/flowgo "{{file}}" --host &
        else
            go run ./cmd/flowgo "{{file}}" --host &
            started=1
        fi
        GO_PID=$!
        touch "$marker"
    }

    start_go
    while :; do
        sleep 0.5
        changed=0
        while IFS= read -r f; do
            if [[ "$f" -nt "$marker" ]]; then changed=1; break; fi
        done < <(find . \( -name '*.go' -o -path './pkg/flowgo/dist/index.html' \) -not -path './node_modules/*' 2>/dev/null)
        (( changed )) && start_go
    done

# One-shot frontend build (writes pkg/flowgo/dist/index.html that the library embeds).
build-frontend:
    pnpm install --silent
    pnpm exec vite build

# Build the Go binary with the freshly built frontend embedded.
build: build-frontend
    go build -o flowgo ./cmd/flowgo

# Run both test suites.
test:
    pnpm exec vitest run
    go test ./...

# Type-check the TypeScript without emitting.
typecheck:
    pnpm exec tsc --noEmit
