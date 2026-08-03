// Minimal provider adapters: each turns (system, userPrompt, tool) into
// a normalised { toolCalls, text } response classify.js can score.
// Deliberately hand-rolled against the raw HTTP APIs (no SDK
// dependency) — this harness has exactly one call site per provider,
// and a raw fetch keeps `eval/` dependency-free like the rest of this
// repo's tooling.
//
// Every exported "call" function is a thin wrapper: build the
// provider-specific request body, POST it, and hand the *raw parsed
// JSON* to that provider's `normalise` function. Splitting build vs.
// normalise like this is what makes providers.test.js possible without
// a real network call — the tests feed canned response fixtures
// straight into normalise().

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/**
 * @param {{name:string, description:string, input_schema:object}} tool
 */
function anthropicToolShape(tool) {
  return { name: tool.name, description: tool.description, input_schema: tool.input_schema };
}

/**
 * @param {{name:string, description:string, input_schema:object}} tool
 */
function openaiToolShape(tool) {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
  };
}

/** Normalises a raw Anthropic Messages API response body. */
export function normaliseAnthropicResponse(body) {
  const content = body.content ?? [];
  const toolCalls = content
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ name: b.name, input: b.input }));
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { toolCalls, text };
}

/** Normalises a raw OpenAI Chat Completions API response body. */
export function normaliseOpenAIResponse(body) {
  const message = body.choices?.[0]?.message ?? {};
  const toolCalls = (message.tool_calls ?? []).map((tc) => {
    let input;
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = tc.function.arguments;
    }
    return { name: tc.function.name, input };
  });
  return { toolCalls, text: message.content ?? "" };
}

/**
 * @param {{apiModel: string, system: string, prompt: string, tool: object, apiKey: string}} args
 */
export async function callAnthropic({ apiModel, system, prompt, tool, apiKey }) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: apiModel,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: prompt }],
      tools: [anthropicToolShape(tool)],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  return normaliseAnthropicResponse(await res.json());
}

/**
 * @param {{apiModel: string, system: string, prompt: string, tool: object, apiKey: string}} args
 */
export async function callOpenAI({ apiModel, system, prompt, tool, apiKey }) {
  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: apiModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      tools: [openaiToolShape(tool)],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  }
  return normaliseOpenAIResponse(await res.json());
}

// Model registry: eval-facing id -> { provider, apiModel, envKey }.
// Add a row here to add a model to the matrix; no other code changes
// needed as long as it's Anthropic- or OpenAI-shaped. A genuinely
// different API shape (Gemini, etc.) needs its own call*/normalise*
// pair above plus a "provider" branch in run.js.
export const MODEL_REGISTRY = {
  "claude-sonnet-5": { provider: "anthropic", apiModel: "claude-sonnet-5", envKey: "ANTHROPIC_API_KEY" },
  "claude-opus-5": { provider: "anthropic", apiModel: "claude-opus-5", envKey: "ANTHROPIC_API_KEY" },
  "gpt-5": { provider: "openai", apiModel: "gpt-5", envKey: "OPENAI_API_KEY" },
};

/** @param {string} modelId */
export async function callModel(modelId, { system, prompt, tool }) {
  const entry = MODEL_REGISTRY[modelId];
  if (!entry) {
    throw new Error(`unknown model id ${JSON.stringify(modelId)} — add it to MODEL_REGISTRY in providers.js`);
  }
  const apiKey = process.env[entry.envKey];
  if (!apiKey) {
    throw new Error(`${entry.envKey} is not set — required to eval ${modelId}`);
  }
  const call = entry.provider === "anthropic" ? callAnthropic : callOpenAI;
  return call({ apiModel: entry.apiModel, system, prompt, tool, apiKey });
}
