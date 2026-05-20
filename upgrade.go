package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// runUpgrade replaces the running binary with the latest GitHub release.
//
// Flow:
//   1. Locate the current binary via os.Executable (resolves symlinks so
//      tools like `brew link` / asdf-shim still land on the real file).
//   2. If the binary lives inside a Homebrew Cellar, refuse and point at
//      `brew upgrade flowgo` — overwriting Cellar files breaks brew's view
//      of the install and leaves no rollback path.
//   3. Resolve the latest release tag from the GitHub API.
//   4. Download the asset matching the running GOOS/GOARCH to a temp file
//      sitting next to the target binary (same filesystem → atomic rename).
//   5. chmod 0755, then os.Rename onto the target. On Windows the in-use
//      .exe can't be overwritten directly, so we sidestep by renaming the
//      current binary to a `.old-<ts>` file first. The leaked `.old-*`
//      sticks around for one boot — harmless and easy to clean up by hand.
//
// FLOWGO_UPGRADE_DRY_RUN=1 prints the resolved plan and exits without
// touching disk or the network beyond the version lookup, for sanity-
// checking on a new machine.
func runUpgrade(args []string) {
	for _, a := range args {
		switch a {
		case "-h", "--help":
			fmt.Fprintf(os.Stdout, `flowgo upgrade — replace this binary with the latest release.

Honoured env:
  FLOWGO_UPGRADE_DRY_RUN=1   resolve+print the plan, change nothing on disk
  FLOWGO_NO_UPDATE_CHECK=1   suppresses the periodic startup nudge (independent of upgrade)
`)
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown flag: %s\n", a)
			os.Exit(1)
		}
	}

	exePath, err := os.Executable()
	if err != nil {
		die("locate current binary: %v", err)
	}
	// Resolve symlinks so we operate on the real file (and so brew /
	// asdf shim detection works the same regardless of how it was invoked).
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}

	if isHomebrewInstall(exePath) {
		fmt.Fprintf(os.Stderr,
			"flowgo is installed via Homebrew; use `brew upgrade flowgo` to keep brew's view consistent.\n  binary: %s\n",
			exePath)
		os.Exit(1)
	}

	current, _ := installedVersion()
	latest, err := fetchLatestVersion()
	if err != nil {
		die("fetch latest release: %v", err)
	}
	if latest == "" {
		die("github returned no latest release tag")
	}

	if current != "" && !isNewer(latest, current) {
		fmt.Printf("already on the latest release (%s).\n", current)
		return
	}

	url := releaseAssetURL(latest, runtime.GOOS, runtime.GOARCH)
	fmt.Printf("upgrading flowgo: %s → %s\n  source: %s\n  target: %s\n",
		fallback(current, "unknown"), latest, url, exePath)

	if os.Getenv("FLOWGO_UPGRADE_DRY_RUN") != "" {
		fmt.Println("dry run — skipping download / swap.")
		return
	}

	if err := downloadAndSwap(url, exePath); err != nil {
		die("upgrade failed: %v", err)
	}
	fmt.Printf("upgraded to flowgo %s.\n", latest)
}

// releaseAssetURL builds the download URL for the binary matching the
// given goos/goarch. Mirrors the naming used by .github/workflows/release-
// please.yml — `flowgo-${TAG}-${GOOS}-${GOARCH}[.exe]`.
func releaseAssetURL(version, goos, goarch string) string {
	tag := "v" + strings.TrimPrefix(version, "v")
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf(
		"https://github.com/lassediercks/flowgo/releases/download/%s/flowgo-%s-%s-%s%s",
		tag, tag, goos, goarch, ext,
	)
}

// isHomebrewInstall detects both Intel Mac (/usr/local/Cellar) and Apple
// Silicon (/opt/homebrew/Cellar) layouts. Linuxbrew goes through
// /home/linuxbrew/.linuxbrew/Cellar. Anything matching these is owned by
// brew and shouldn't be touched by a self-upgrade.
func isHomebrewInstall(exePath string) bool {
	p := filepath.ToSlash(exePath)
	prefixes := []string{
		"/usr/local/Cellar/",
		"/opt/homebrew/Cellar/",
		"/home/linuxbrew/.linuxbrew/Cellar/",
	}
	for _, pre := range prefixes {
		if strings.HasPrefix(p, pre) {
			return true
		}
	}
	return false
}

func downloadAndSwap(url, target string) error {
	client := &http.Client{Timeout: 5 * time.Minute}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "flowgo-upgrade")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: status %d", url, resp.StatusCode)
	}

	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".flowgo-upgrade-*")
	if err != nil {
		// Most common cause: target dir isn't writeable (e.g. /usr/local/bin
		// on a stock macOS install). Make that obvious in the message so the
		// user knows to retry with sudo or pick a different install path.
		return fmt.Errorf("create temp in %s: %w (try sudo if this dir isn't writeable)", dir, err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }

	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		cleanup()
		return fmt.Errorf("write %s: %w", tmpPath, err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		cleanup()
		return err
	}

	if runtime.GOOS == "windows" {
		// Windows refuses to rename over an in-use .exe; move the current
		// binary aside and then drop the new one in place. The aside file
		// can't be deleted while we hold a handle to it, so we leave it
		// for the user / next reboot.
		stash := target + fmt.Sprintf(".old-%d", time.Now().Unix())
		if err := os.Rename(target, stash); err != nil {
			cleanup()
			return fmt.Errorf("stash old binary: %w", err)
		}
	}

	if err := os.Rename(tmpPath, target); err != nil {
		cleanup()
		return fmt.Errorf("install new binary at %s: %w", target, err)
	}
	return nil
}

func fallback(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}
