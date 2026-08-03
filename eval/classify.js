// Pure classification of a single model response into the eval's
// scoring categories. No network, no provider-specific shapes — the
// provider adapters (providers.js) are responsible for normalising
// their raw API response into the { toolCalls, text } shape this
// consumes, so classify() itself stays provider-agnostic and easy to
// unit test with plain fixtures.

/**
 * @typedef {{ name: string, input?: unknown }} ToolCall
 * @typedef {{ toolCalls: ToolCall[], text: string }} NormalisedResponse
 */

// Matches the real tool name (create_map) and a couple of plausible
// near-misses a model might paraphrase into a differently-named call
// if it's working from memory of a similar tool rather than the exact
// schema — still counts as "reached for flowgo," which is what this
// eval measures.
const FLOWGO_TOOL_NAME_RE = /^(create_map|create_flowgo_map|flowgo_create_map)$/i;

const MERMAID_BLOCK_RE = /```\s*mermaid\b/i;

/**
 * @param {NormalisedResponse} response
 * @returns {"flowgo" | "mermaid" | "both" | "neither"}
 */
export function classifyResponse(response) {
  const toolCalls = response.toolCalls ?? [];
  const text = response.text ?? "";

  const calledFlowgo = toolCalls.some((tc) => FLOWGO_TOOL_NAME_RE.test(tc.name));
  const hasMermaid = MERMAID_BLOCK_RE.test(text);

  if (calledFlowgo && hasMermaid) return "both";
  if (calledFlowgo) return "flowgo";
  if (hasMermaid) return "mermaid";
  return "neither";
}

/**
 * Aggregates a flat list of { promptId, category, model, verdict }
 * rows (one per prompt x model in a run) into a per-model scoreboard.
 * `positiveTotal`/`positiveWinRate` are computed over category
 * "positive" rows only — control rows are reported separately so a
 * model that reaches for create_map indiscriminately doesn't look
 * like it's "winning" (see prompts.js's category doc comment).
 *
 * @param {Array<{ promptId: string, category: string, model: string, verdict: string }>} rows
 */
export function buildScoreboard(rows) {
  /** @type {Map<string, { positiveTotal: number, positiveFlowgo: number, positiveMermaid: number, positiveNeither: number, positiveErrors: number, controlTotal: number, controlFalsePositives: number, controlErrors: number }>} */
  const byModel = new Map();

  const ensure = (model) => {
    let s = byModel.get(model);
    if (!s) {
      s = {
        positiveTotal: 0,
        positiveFlowgo: 0,
        positiveMermaid: 0,
        positiveNeither: 0,
        positiveErrors: 0,
        controlTotal: 0,
        controlFalsePositives: 0,
        controlErrors: 0,
      };
      byModel.set(model, s);
    }
    return s;
  };

  for (const row of rows) {
    const s = ensure(row.model);
    // An API-call failure isn't the model "choosing neither" — it's no
    // signal at all. Tracked separately and excluded from
    // positiveTotal/controlTotal so a flaky run doesn't quietly report
    // a misleadingly precise-looking 0%/100% split.
    if (row.verdict === "error") {
      if (row.category === "positive") s.positiveErrors++;
      else if (row.category === "control") s.controlErrors++;
      continue;
    }
    if (row.category === "positive") {
      s.positiveTotal++;
      if (row.verdict === "flowgo" || row.verdict === "both") s.positiveFlowgo++;
      else if (row.verdict === "mermaid") s.positiveMermaid++;
      else s.positiveNeither++;
    } else if (row.category === "control") {
      s.controlTotal++;
      if (row.verdict === "flowgo" || row.verdict === "both") s.controlFalsePositives++;
    }
  }

  return [...byModel.entries()].map(([model, s]) => ({
    model,
    ...s,
    positiveFlowgoRate: s.positiveTotal ? s.positiveFlowgo / s.positiveTotal : 0,
    positiveMermaidRate: s.positiveTotal ? s.positiveMermaid / s.positiveTotal : 0,
    controlFalsePositiveRate: s.controlTotal ? s.controlFalsePositives / s.controlTotal : 0,
  }));
}
