package flowgo

import "testing"

// intFromAny is the tolerant number reader for MCP tool arguments —
// JSON gives float64, agents sometimes send strings. Silent zero on
// garbage is the documented fallback, so the table pins it explicitly
// rather than leaving it as an accident.
func TestIntFromAny(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want int
	}{
		{"int passes through", int(7), 7},
		{"float64 truncates toward zero", float64(3.9), 3},
		{"negative float truncates toward zero", float64(-3.9), -3},
		{"numeric string parses", "42", 42},
		{"negative numeric string parses", "-8", -8},
		{"garbage string is zero", "seven", 0},
		{"nil is zero", nil, 0},
		{"bool is zero", true, 0},
		{"float32 is zero (only float64 arrives from JSON)", float32(5), 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := intFromAny(c.in); got != c.want {
				t.Fatalf("intFromAny(%#v) = %d, want %d", c.in, got, c.want)
			}
		})
	}
}
