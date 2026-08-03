import { test } from "node:test";
import assert from "node:assert/strict";

import { run } from "./run.js";
import { PROMPTS } from "./prompts.js";

// Fake model: always "chooses" flowgo for positive prompts and stays
// silent (plain text, no tool call) on control prompts — a
// well-behaved model, so this also exercises the "no false positives"
// path end-to-end through run() -> classifyResponse().
async function fakeCallModelFn(model, { prompt }) {
  const isPositivePrompt = PROMPTS.find((p) => p.text === prompt)?.category === "positive";
  if (isPositivePrompt) {
    return { toolCalls: [{ name: "create_map", input: { flowgo_text: "node b1 hi 0 0\n" } }], text: "" };
  }
  return { toolCalls: [], text: "Sure, here's the answer." };
}

test("run(): produces one row per model x prompt, using the injected caller", async () => {
  const rows = await run({ models: ["fake-model-a", "fake-model-b"], delayMs: 0, callModelFn: fakeCallModelFn });
  assert.equal(rows.length, 2 * PROMPTS.length);
  for (const row of rows) {
    assert.ok(row.model === "fake-model-a" || row.model === "fake-model-b");
    assert.ok(PROMPTS.some((p) => p.id === row.promptId));
  }
});

test("run(): a well-behaved fake model scores 100% on positive prompts, 0% false positives on controls", async () => {
  const rows = await run({ models: ["fake-model"], delayMs: 0, callModelFn: fakeCallModelFn });
  const positiveRows = rows.filter((r) => r.category === "positive");
  const controlRows = rows.filter((r) => r.category === "control");
  assert.ok(positiveRows.every((r) => r.verdict === "flowgo"));
  assert.ok(controlRows.every((r) => r.verdict === "neither"));
});

test("run(): a per-call failure is recorded as an 'error' verdict, not thrown", async () => {
  const flaky = async (model, { prompt }) => {
    if (prompt === PROMPTS[0].text) throw new Error("simulated API failure");
    return { toolCalls: [], text: "" };
  };
  const rows = await run({ models: ["fake-model"], delayMs: 0, callModelFn: flaky });
  const failed = rows.find((r) => r.promptId === PROMPTS[0].id);
  assert.equal(failed.verdict, "error");
  assert.match(failed.error, /simulated API failure/);
  // The rest of the matrix still completed.
  assert.equal(rows.length, PROMPTS.length);
});
