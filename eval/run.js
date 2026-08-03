#!/usr/bin/env node
// CLI runner (brain#218): sends every prompt in prompts.js to every
// requested model, classifies the response, writes the raw rows to
// eval/results/<ISO-timestamp>.json (committed — see README's "why
// commit results" section), and prints this run's scoreboard.
//
// Usage:
//   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node eval/run.js
//   node eval/run.js --models claude-sonnet-5,gpt-5
//
// A per-call failure (bad key, rate limit, network) is recorded as a
// "error" verdict rather than crashing the whole matrix — one model
// having a bad day shouldn't lose the rest of the run's data.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PROMPTS } from "./prompts.js";
import { CREATE_MAP_TOOL, SYSTEM_PROMPT } from "./tools.js";
import { callModel, MODEL_REGISTRY } from "./providers.js";
import { classifyResponse, buildScoreboard } from "./classify.js";

const here = dirname(fileURLToPath(import.meta.url));

function parseModels(argv) {
  const flag = argv.find((a) => a.startsWith("--models="));
  if (flag) return flag.slice("--models=".length).split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.EVAL_MODELS) return process.env.EVAL_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  return Object.keys(MODEL_REGISTRY);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printScoreboard(scoreboard) {
  console.log("\nScoreboard (this run):\n");
  console.log(
    ["model", "flowgo%", "mermaid%", "neither%", "control false-positive%", "errors"].join(" | "),
  );
  for (const s of scoreboard) {
    console.log(
      [
        s.model,
        (s.positiveFlowgoRate * 100).toFixed(0) + "%",
        (s.positiveMermaidRate * 100).toFixed(0) + "%",
        ((s.positiveNeither / (s.positiveTotal || 1)) * 100).toFixed(0) + "%",
        (s.controlFalsePositiveRate * 100).toFixed(0) + "%",
        `${s.positiveErrors + s.controlErrors}`,
      ].join(" | "),
    );
    if (s.positiveTotal === 0 && s.controlTotal === 0) {
      console.error(`  ⚠ ${s.model}: every call errored out — rates above are meaningless (0/0). See errors logged during the run.`);
    }
  }
}

export async function run({ models, delayMs = 200, callModelFn = callModel } = {}) {
  const rows = [];
  for (const model of models) {
    for (const prompt of PROMPTS) {
      let verdict;
      let error;
      try {
        const response = await callModelFn(model, {
          system: SYSTEM_PROMPT,
          prompt: prompt.text,
          tool: CREATE_MAP_TOOL,
        });
        verdict = classifyResponse(response);
      } catch (err) {
        verdict = "error";
        error = String(err?.message ?? err);
        console.error(`[${model}] ${prompt.id}: ${error}`);
      }
      rows.push({ model, promptId: prompt.id, category: prompt.category, verdict, ...(error ? { error } : {}) });
      if (delayMs) await sleep(delayMs);
    }
  }
  return rows;
}

async function main() {
  const models = parseModels(process.argv.slice(2));
  console.log(`Running eval for models: ${models.join(", ")} (${PROMPTS.length} prompts each)`);

  const rows = await run({ models });

  const resultsDir = join(here, "results");
  mkdirSync(resultsDir, { recursive: true });
  const timestamp = process.env.EVAL_TIMESTAMP_OVERRIDE || new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(resultsDir, `${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify({ ranAt: timestamp, models, rows }, null, 2) + "\n");
  console.log(`\nWrote ${rows.length} rows to ${outPath}`);

  printScoreboard(buildScoreboard(rows));
}

// Only auto-run when invoked directly (`node eval/run.js`), not when
// imported by run.test.js.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
