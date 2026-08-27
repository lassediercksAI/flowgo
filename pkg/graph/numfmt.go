package graph

import (
	"math"
	"strconv"
	"strings"
)

// jsNumberString formats f exactly the way JavaScript's
// Number.prototype.toString() would (ECMA-262 Number::toString,
// radix 10). It exists because Go's `%g` verb (what Serialize used to
// use directly) switches to scientific notation at a much smaller
// exponent than JS does: Go flips around exponent 6, JS not until
// exponent 21. So the same Graph serialized on the two sides used to
// disagree on ordinary numbers — 1000000 came out as "1e+06" from Go
// and "1000000" from the TS serializer (which just calls
// String(n), i.e. the real JS algorithm). The editor's own
// MAX_TRANSLATE is 1,000,000, so a user dragging a node to the edge
// of the canvas reached this with no crafting required.
//
// The digit sequence itself doesn't need reinventing: both Go's
// strconv (Ryu) and JS engines compute the same "shortest decimal
// string that round-trips to this exact float64" for a given value —
// that's a mathematical property of the value, not an implementation
// choice, so the two already agree on it. What differs is only the
// *notation* built on top of those digits (where the decimal point
// goes, and the threshold for switching to scientific form). This
// function reuses strconv.FormatFloat's shortest round-trip 'e' form
// for the digits/exponent and then applies the ECMA-262 layout rules
// (Number::toString steps 6-19) on top — the same division of labor
// JS engines themselves use internally.
func jsNumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		// Folds -0 to "0", matching (-0).toString() === "0" in JS.
		return "0"
	}

	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}

	// Shortest round-trip digits in normalized scientific form, e.g.
	// "1e+06" or "1.234e-05" — always exactly one digit before the
	// point, so mantissa minus its single '.' gives the digit string.
	es := strconv.FormatFloat(f, 'e', -1, 64)
	mantissa, expStr, ok := strings.Cut(es, "e")
	expVal, err := strconv.Atoi(expStr)
	if !ok || err != nil {
		// Unreachable for a finite, non-zero float64 — FormatFloat with
		// the 'e' verb always emits an exponent. Fall back rather than
		// panic if that ever stops being true.
		return sign + es
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	k := len(digits) // number of significant digits
	n := expVal + 1  // value = 0.digits * 10^n

	var s string
	switch {
	case k <= n && n <= 21:
		// Plain integer: digits followed by trailing zeros.
		s = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		// Decimal point lands inside the digit string.
		s = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		// "0." followed by leading zeros then the digits.
		s = "0." + strings.Repeat("0", -n) + digits
	default:
		// Scientific notation: JS never zero-pads the exponent and
		// omits the '.' entirely when there's only one digit.
		d := digits[:1]
		if k > 1 {
			d += "." + digits[1:]
		}
		e := n - 1
		expSign := "+"
		if e < 0 {
			expSign = "-"
			e = -e
		}
		s = d + "e" + expSign + strconv.Itoa(e)
	}
	return sign + s
}
