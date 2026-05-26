package main

import (
	"net"
	"testing"
)

// releaseAssetURL must match the naming used by the release-please.yml
// workflow's matrix step (`flowgo-${TAG}-${GOOS}-${GOARCH}${ext}`),
// otherwise `flowgo upgrade` would 404 on every platform.
func TestReleaseAssetURL(t *testing.T) {
	cases := []struct {
		name, version, goos, goarch, want string
	}{
		{
			name: "darwin arm64", version: "0.1.0", goos: "darwin", goarch: "arm64",
			want: "https://github.com/lassediercks/flowgo/releases/download/v0.1.0/flowgo-v0.1.0-darwin-arm64",
		},
		{
			name: "linux amd64", version: "1.2.3", goos: "linux", goarch: "amd64",
			want: "https://github.com/lassediercks/flowgo/releases/download/v1.2.3/flowgo-v1.2.3-linux-amd64",
		},
		{
			name: "windows amd64 ext", version: "0.4.0", goos: "windows", goarch: "amd64",
			want: "https://github.com/lassediercks/flowgo/releases/download/v0.4.0/flowgo-v0.4.0-windows-amd64.exe",
		},
		{
			name: "leading v in version is normalised", version: "v0.1.0", goos: "linux", goarch: "arm64",
			want: "https://github.com/lassediercks/flowgo/releases/download/v0.1.0/flowgo-v0.1.0-linux-arm64",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := releaseAssetURL(tc.version, tc.goos, tc.goarch)
			if got != tc.want {
				t.Fatalf("releaseAssetURL: got %q, want %q", got, tc.want)
			}
		})
	}
}

// Homebrew-owned binaries must refuse self-upgrade and route the user
// through `brew upgrade flowgo`. Linuxbrew + both macOS layouts covered.
func TestIsHomebrewInstall(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/usr/local/Cellar/flowgo/0.1.0/bin/flowgo", true},
		{"/opt/homebrew/Cellar/flowgo/0.1.0/bin/flowgo", true},
		{"/home/linuxbrew/.linuxbrew/Cellar/flowgo/0.1.0/bin/flowgo", true},
		{"/usr/local/bin/flowgo", false},
		{"/opt/homebrew/bin/flowgo", false},
		{"/Users/me/go/bin/flowgo", false},
		{"/tmp/flowgo", false},
	}
	for _, tc := range cases {
		if got := isHomebrewInstall(tc.path); got != tc.want {
			t.Errorf("isHomebrewInstall(%q) = %v, want %v", tc.path, got, tc.want)
		}
	}
}

// pickLanIPFromAddrs prefers private (RFC 1918) IPv4 over public, and
// skips loopback / link-local / IPv6 / non-IPNet entries. Tested with
// hand-rolled net.Addr fixtures so the test is hermetic.
func TestPickLanIPFromAddrs(t *testing.T) {
	ipnet := func(s string) *net.IPNet {
		ip, n, err := net.ParseCIDR(s)
		if err != nil {
			t.Fatal(err)
		}
		n.IP = ip
		return n
	}
	cases := []struct {
		name string
		in   []net.Addr
		want string
	}{
		{"empty", nil, ""},
		{"loopback only", []net.Addr{ipnet("127.0.0.1/8")}, ""},
		{
			"link-local only",
			[]net.Addr{ipnet("169.254.1.5/16")},
			"",
		},
		{
			"private wins over public",
			[]net.Addr{ipnet("8.8.8.8/32"), ipnet("192.168.1.5/24")},
			"192.168.1.5",
		},
		{
			"first private wins when several",
			[]net.Addr{ipnet("10.0.0.5/8"), ipnet("192.168.1.5/24")},
			"10.0.0.5",
		},
		{
			"public falls through when no private",
			[]net.Addr{ipnet("203.0.113.5/24")},
			"203.0.113.5",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pickLanIPFromAddrs(tc.in)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
