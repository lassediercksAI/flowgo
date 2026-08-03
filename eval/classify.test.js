import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyResponse, buildScoreboard } from "./classify.js";

test("classifyResponse: flowgo tool call only", () => {
  const got = classifyResponse({ toolCalls: [{ name: "create_map", input: {} }], text: "Here's your map!" });
  assert.equal(got, "flowgo");
});

test("classifyResponse: mermaid fenced block only", () => {
  const got = classifyResponse({ toolCalls: [], text: "Sure, here you go:\n```mermaid\ngraph TD; A-->B;\n```" });
  assert.equal(got, "mermaid");
});

test("classifyResponse: both a tool call and a mermaid block", () => {
  const got = classifyResponse({
    toolCalls: [{ name: "create_map" }],
    text: "```mermaid\ngraph TD; A-->B;\n```",
  });
  assert.equal(got, "both");
});

test("classifyResponse: neither — plain prose response", () => {
  const got = classifyResponse({ toolCalls: [], text: "Sure! Step 1 is login, step 2 is issuing a session cookie." });
  assert.equal(got, "neither");
});

test("classifyResponse: near-miss tool names still count as flowgo", () => {
  for (const name of ["create_map", "CREATE_MAP", "create_flowgo_map", "flowgo_create_map"]) {
    assert.equal(classifyResponse({ toolCalls: [{ name }], text: "" }), "flowgo", `expected ${name} to count as flowgo`);
  }
});

test("classifyResponse: an unrelated tool call is not flowgo", () => {
  const got = classifyResponse({ toolCalls: [{ name: "web_search" }], text: "" });
  assert.equal(got, "neither");
});

test("classifyResponse: missing fields default safely", () => {
  assert.equal(classifyResponse({}), "neither");
});

test("buildScoreboard: computes positive win-rates and control false-positive rate", () => {
  const rows = [
    { model: "m1", promptId: "p1", category: "positive", verdict: "flowgo" },
    { model: "m1", promptId: "p2", category: "positive", verdict: "mermaid" },
    { model: "m1", promptId: "p3", category: "positive", verdict: "neither" },
    { model: "m1", promptId: "p4", category: "positive", verdict: "flowgo" },
    { model: "m1", promptId: "c1", category: "control", verdict: "neither" },
    { model: "m1", promptId: "c2", category: "control", verdict: "flowgo" }, // false positive
  ];
  const [scoreboard] = buildScoreboard(rows);
  assert.equal(scoreboard.model, "m1");
  assert.equal(scoreboard.positiveTotal, 4);
  assert.equal(scoreboard.positiveFlowgo, 2);
  assert.equal(scoreboard.positiveMermaid, 1);
  assert.equal(scoreboard.positiveNeither, 1);
  assert.equal(scoreboard.positiveFlowgoRate, 0.5);
  assert.equal(scoreboard.controlTotal, 2);
  assert.equal(scoreboard.controlFalsePositives, 1);
  assert.equal(scoreboard.controlFalsePositiveRate, 0.5);
});

test("buildScoreboard: 'both' verdicts count toward the flowgo rate", () => {
  const rows = [
    { model: "m1", promptId: "p1", category: "positive", verdict: "both" },
  ];
  const [scoreboard] = buildScoreboard(rows);
  assert.equal(scoreboard.positiveFlowgo, 1);
  assert.equal(scoreboard.positiveFlowgoRate, 1);
});

test("buildScoreboard: keeps models independent", () => {
  const rows = [
    { model: "m1", promptId: "p1", category: "positive", verdict: "flowgo" },
    { model: "m2", promptId: "p1", category: "positive", verdict: "neither" },
  ];
  const scoreboard = buildScoreboard(rows);
  const byModel = Object.fromEntries(scoreboard.map((s) => [s.model, s]));
  assert.equal(byModel.m1.positiveFlowgoRate, 1);
  assert.equal(byModel.m2.positiveFlowgoRate, 0);
});

test("buildScoreboard: no rows for a model with zero prompts of a category doesn't divide by zero", () => {
  const rows = [{ model: "m1", promptId: "p1", category: "positive", verdict: "flowgo" }];
  const [scoreboard] = buildScoreboard(rows);
  assert.equal(scoreboard.controlFalsePositiveRate, 0);
});

test("buildScoreboard: 'error' rows are excluded from totals/rates and tracked separately", () => {
  const rows = [
    { model: "m1", promptId: "p1", category: "positive", verdict: "flowgo" },
    { model: "m1", promptId: "p2", category: "positive", verdict: "error", error: "boom" },
    { model: "m1", promptId: "c1", category: "control", verdict: "error", error: "boom" },
  ];
  const [scoreboard] = buildScoreboard(rows);
  // Only the one real positive row counts toward the denominator — the
  // errored-out row must not silently masquerade as "neither".
  assert.equal(scoreboard.positiveTotal, 1);
  assert.equal(scoreboard.positiveFlowgo, 1);
  assert.equal(scoreboard.positiveNeither, 0);
  assert.equal(scoreboard.positiveFlowgoRate, 1);
  assert.equal(scoreboard.positiveErrors, 1);
  assert.equal(scoreboard.controlTotal, 0);
  assert.equal(scoreboard.controlErrors, 1);
});

test("buildScoreboard: all-error run reports zero totals rather than a fabricated 100% 'neither' rate", () => {
  const rows = [
    { model: "m1", promptId: "p1", category: "positive", verdict: "error", error: "no api key" },
    { model: "m1", promptId: "p2", category: "positive", verdict: "error", error: "no api key" },
  ];
  const [scoreboard] = buildScoreboard(rows);
  assert.equal(scoreboard.positiveTotal, 0);
  assert.equal(scoreboard.positiveErrors, 2);
  assert.equal(scoreboard.positiveFlowgoRate, 0);
});
