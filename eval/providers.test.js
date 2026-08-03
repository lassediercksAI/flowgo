import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normaliseAnthropicResponse,
  normaliseOpenAIResponse,
  callModel,
  MODEL_REGISTRY,
} from "./providers.js";

test("normaliseAnthropicResponse: extracts tool_use blocks and joins text blocks", () => {
  const body = {
    content: [
      { type: "text", text: "Sure, here's your map:" },
      { type: "tool_use", name: "create_map", input: { flowgo_text: "node b1 hi 0 0\n" } },
    ],
  };
  const got = normaliseAnthropicResponse(body);
  assert.deepEqual(got.toolCalls, [{ name: "create_map", input: { flowgo_text: "node b1 hi 0 0\n" } }]);
  assert.equal(got.text, "Sure, here's your map:");
});

test("normaliseAnthropicResponse: text-only response has no tool calls", () => {
  const body = { content: [{ type: "text", text: "```mermaid\ngraph TD; A-->B;\n```" }] };
  const got = normaliseAnthropicResponse(body);
  assert.deepEqual(got.toolCalls, []);
  assert.match(got.text, /mermaid/);
});

test("normaliseAnthropicResponse: missing content array doesn't throw", () => {
  assert.deepEqual(normaliseAnthropicResponse({}), { toolCalls: [], text: "" });
});

test("normaliseOpenAIResponse: extracts function tool_calls and parses JSON arguments", () => {
  const body = {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { function: { name: "create_map", arguments: JSON.stringify({ flowgo_text: "node b1 hi 0 0\n" }) } },
          ],
        },
      },
    ],
  };
  const got = normaliseOpenAIResponse(body);
  assert.deepEqual(got.toolCalls, [{ name: "create_map", input: { flowgo_text: "node b1 hi 0 0\n" } }]);
});

test("normaliseOpenAIResponse: text-only response", () => {
  const body = { choices: [{ message: { content: "```mermaid\ngraph TD;\n```" } }] };
  const got = normaliseOpenAIResponse(body);
  assert.deepEqual(got.toolCalls, []);
  assert.match(got.text, /mermaid/);
});

test("normaliseOpenAIResponse: malformed tool-call arguments fall back to the raw string rather than throwing", () => {
  const body = {
    choices: [{ message: { tool_calls: [{ function: { name: "create_map", arguments: "not json" } }] } }],
  };
  const got = normaliseOpenAIResponse(body);
  assert.equal(got.toolCalls[0].name, "create_map");
  assert.equal(got.toolCalls[0].input, "not json");
});

test("normaliseOpenAIResponse: missing choices doesn't throw", () => {
  assert.deepEqual(normaliseOpenAIResponse({}), { toolCalls: [], text: "" });
});

test("callModel: unknown model id throws before any network call", async () => {
  await assert.rejects(
    () => callModel("not-a-real-model", { system: "s", prompt: "p", tool: {} }),
    /unknown model id/,
  );
});

test("callModel: missing API key env var throws before any network call", async () => {
  const model = Object.keys(MODEL_REGISTRY)[0];
  const envKey = MODEL_REGISTRY[model].envKey;
  const saved = process.env[envKey];
  delete process.env[envKey];
  try {
    await assert.rejects(
      () => callModel(model, { system: "s", prompt: "p", tool: {} }),
      new RegExp(`${envKey} is not set`),
    );
  } finally {
    if (saved !== undefined) process.env[envKey] = saved;
  }
});
