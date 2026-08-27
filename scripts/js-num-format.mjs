#!/usr/bin/env node
// Ground truth for the Go/TS float-formatting parity test
// (pkg/graph/numfmt_parity_test.go). Reads one decimal number per
// line on stdin, prints `Number.prototype.toString()` of each,
// one per line, on stdout.
//
// This is deliberately *not* a copy of src/graph/serialize.ts's
// flowgoNum() — flowgoNum is already just `String(n)`, i.e. this
// exact algorithm, so re-implementing it here would only prove the
// Go side agrees with our own restatement of the rule. Shelling out
// to a real `node` binary checks pkg/graph's jsNumberString against
// the actual JavaScript engine the browser build runs on, which is
// the thing that has to match byte-for-byte.
//
// Values cross stdin as decimal text rather than as command-line
// arguments so the Go side can send arbitrarily many without hitting
// an OS argv length limit, and so neither side needs shell quoting.

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);
  const out = lines.map((l) => String(Number(l)));
  process.stdout.write(out.join("\n") + (out.length ? "\n" : ""));
});
