import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRuns, buildTrend } from "./scoreboard.js";

function withTempResultsDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "flowgo-eval-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadRuns: reads and sorts run files chronologically by filename", () => {
  withTempResultsDir((dir) => {
    writeFileSync(join(dir, "2026-01-02T00-00-00.json"), JSON.stringify({ ranAt: "2026-01-02", rows: [] }));
    writeFileSync(join(dir, "2026-01-01T00-00-00.json"), JSON.stringify({ ranAt: "2026-01-01", rows: [] }));
    const runs = loadRuns(dir);
    assert.deepEqual(runs.map((r) => r.ranAt), ["2026-01-01", "2026-01-02"]);
  });
});

test("loadRuns: ignores non-JSON files in the results directory", () => {
  withTempResultsDir((dir) => {
    writeFileSync(join(dir, "README.md"), "not a run");
    writeFileSync(join(dir, "run.json"), JSON.stringify({ ranAt: "2026-01-01", rows: [] }));
    const runs = loadRuns(dir);
    assert.equal(runs.length, 1);
  });
});

test("buildTrend: tracks each model's flowgo win-rate across multiple runs in order", () => {
  const runs = [
    {
      ranAt: "2026-01-01",
      rows: [
        { model: "m1", promptId: "p1", category: "positive", verdict: "neither" },
        { model: "m1", promptId: "c1", category: "control", verdict: "neither" },
      ],
    },
    {
      ranAt: "2026-01-08",
      rows: [
        { model: "m1", promptId: "p1", category: "positive", verdict: "flowgo" },
        { model: "m1", promptId: "c1", category: "control", verdict: "neither" },
      ],
    },
  ];
  const trend = buildTrend(runs);
  const m1 = trend.get("m1");
  assert.equal(m1.length, 2);
  assert.equal(m1[0].ranAt, "2026-01-01");
  assert.equal(m1[0].positiveFlowgoRate, 0);
  assert.equal(m1[1].ranAt, "2026-01-08");
  assert.equal(m1[1].positiveFlowgoRate, 1);
});

test("buildTrend: a model absent from an earlier run just has fewer points, not a crash", () => {
  const runs = [
    { ranAt: "2026-01-01", rows: [{ model: "m1", promptId: "p1", category: "positive", verdict: "flowgo" }] },
    {
      ranAt: "2026-01-08",
      rows: [
        { model: "m1", promptId: "p1", category: "positive", verdict: "flowgo" },
        { model: "m2", promptId: "p1", category: "positive", verdict: "mermaid" },
      ],
    },
  ];
  const trend = buildTrend(runs);
  assert.equal(trend.get("m1").length, 2);
  assert.equal(trend.get("m2").length, 1);
});
