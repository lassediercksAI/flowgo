package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

// installedVersion returns the semver of the running binary and whether it
// represents a real installed release. Working-tree builds (go run / go build
// from a checkout) report ok=false so the update check stays quiet for devs.
func installedVersion() (string, bool) {
	if version != "dev" {
		return strings.TrimPrefix(version, "v"), true
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		v := info.Main.Version
		if v != "" && v != "(devel)" {
			return strings.TrimPrefix(v, "v"), true
		}
	}
	return "", false
}

// maybeNotifyNewVersion prints a one-time nudge to stderr if a newer release
// is available on GitHub. Fails silently on any error — this is informational,
// never fatal, never noisy.
//
// Behaviour:
//   - skipped entirely for working-tree dev builds and when
//     FLOWGO_NO_UPDATE_CHECK is set;
//   - prefers a 24h-cached "latest" value so most runs do zero network work;
//   - cache miss / stale: kicks off a goroutine that fetches in the
//     background, writes the cache, and prints if behind. The main process
//     keeps running (http.Serve blocks), so the goroutine has time to land.
func maybeNotifyNewVersion() {
	if os.Getenv("FLOWGO_NO_UPDATE_CHECK") != "" {
		return
	}
	current, ok := installedVersion()
	if !ok {
		return
	}
	if c, ok := readVersionCache(); ok && time.Since(c.CheckedAt) < 24*time.Hour {
		notifyIfNewer(current, c.Latest)
		return
	}
	go func() {
		latest, err := fetchLatestVersion()
		if err != nil || latest == "" {
			return
		}
		writeVersionCache(latest)
		notifyIfNewer(current, latest)
	}()
}

func notifyIfNewer(current, latest string) {
	if !isNewer(latest, current) {
		return
	}
	fmt.Fprintf(os.Stderr,
		"  update available: flowgo %s (you have %s)\n    go install github.com/lassediercks/flowgo@latest\n",
		latest, current)
}

func fetchLatestVersion() (string, error) {
	client := &http.Client{Timeout: 4 * time.Second}
	req, err := http.NewRequest("GET",
		"https://api.github.com/repos/lassediercks/flowgo/releases/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "flowgo-version-check")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("github: status %d", resp.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	return strings.TrimPrefix(body.TagName, "v"), nil
}

type versionCache struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest"`
}

var versionCacheMu sync.Mutex

func versionCachePath() (string, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "flowgo", "version-check.json"), nil
}

func readVersionCache() (versionCache, bool) {
	versionCacheMu.Lock()
	defer versionCacheMu.Unlock()
	p, err := versionCachePath()
	if err != nil {
		return versionCache{}, false
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return versionCache{}, false
	}
	var c versionCache
	if err := json.Unmarshal(data, &c); err != nil {
		return versionCache{}, false
	}
	if c.Latest == "" {
		return versionCache{}, false
	}
	return c, true
}

func writeVersionCache(latest string) {
	versionCacheMu.Lock()
	defer versionCacheMu.Unlock()
	p, err := versionCachePath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return
	}
	data, err := json.Marshal(versionCache{CheckedAt: time.Now(), Latest: latest})
	if err != nil {
		return
	}
	_ = os.WriteFile(p, data, 0644)
}

// isNewer reports whether latest > current under strict major.minor.patch
// semver. Pre-release and build suffixes are stripped before comparison; any
// version that doesn't parse cleanly returns false (no nudge) so malformed
// tags can never spam users.
func isNewer(latest, current string) bool {
	l, ok := parseSemver(latest)
	if !ok {
		return false
	}
	c, ok := parseSemver(current)
	if !ok {
		return false
	}
	for i := 0; i < 3; i++ {
		if l[i] > c[i] {
			return true
		}
		if l[i] < c[i] {
			return false
		}
	}
	return false
}

func parseSemver(s string) ([3]int, bool) {
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.SplitN(s, ".", 3)
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}
