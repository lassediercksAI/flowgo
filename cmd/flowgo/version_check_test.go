package main

import "testing"

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"0.1.4", "0.1.3", true},
		{"0.2.0", "0.1.9", true},
		{"1.0.0", "0.9.9", true},
		{"v0.1.4", "0.1.3", true},
		{"0.1.4-rc1", "0.1.3", true},
		{"0.1.3", "0.1.3", false},
		{"0.1.2", "0.1.3", false},
		{"0.0.9", "0.0.10", false},
		{"garbage", "0.1.3", false},
		{"0.1.4", "garbage", false},
	}
	for _, c := range cases {
		if got := isNewer(c.latest, c.current); got != c.want {
			t.Errorf("isNewer(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}
