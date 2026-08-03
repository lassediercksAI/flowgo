#!/usr/bin/env node
// Trend report (brain#218's "results tracked over time"): reads every
// committed eval/results/*.json run and prints, per model, the
// positive-prompt flowgo win-rate from each run in chronological
// order — so a lift from a copy change (brain#212) or a model
// upgrade shows up as a visible trend, not just a single snapshot.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildScoreboard } from "./classify.js";

const here = dirname(fileURLToPath(import.meta.url));

/** @param {string} resultsDir */
export function loadRuns(resultsDir) {
  const files = readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort(); // ISO-ish timestamp filenames sort chronologically as strings
  return files.map((f) => JSON.parse(readFileSync(join(resultsDir, f), "utf8")));
}

/**
 * @param {Array<{ranAt: string, rows: Array}>} runs
 * @returns {Map<string, Array<{ranAt: string, positiveFlowgoRate: number, controlFalsePositiveRate: number}>>}
 */
export function buildTrend(runs) {
  /** @type {Map<string, Array<{ranAt: string, positiveFlowgoRate: number, controlFalsePositiveRate: number}>>} */
  const byModel = new Map();
  for (const run of runs) {
    for (const s of buildScoreboard(run.rows)) {
      const list = byModel.get(s.model) ?? [];
      list.push({ ranAt: run.ranAt, positiveFlowgoRate: s.positiveFlowgoRate, controlFalsePositiveRate: s.controlFalsePositiveRate });
      byModel.set(s.model, list);
    }
  }
  return byModel;
}

function main() {
  const resultsDir = join(here, "results");
  let runs;
  try {
    runs = loadRuns(resultsDir);
  } catch (err) {
    console.error(`Could not read ${resultsDir}: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (runs.length === 0) {
    console.log("No eval runs yet — run `node eval/run.js` first.");
    return;
  }

  const trend = buildTrend(runs);
  for (const [model, points] of trend) {
    console.log(`\n${model} — flowgo win-rate on positive prompts, by run:`);
    for (const p of points) {
      console.log(`  ${p.ranAt}: ${(p.positiveFlowgoRate * 100).toFixed(0)}% (control false-positives: ${(p.controlFalsePositiveRate * 100).toFixed(0)}%)`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
