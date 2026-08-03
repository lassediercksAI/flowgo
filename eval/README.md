# eval — tool-choice harness

Measures whether an LLM reaches for the `create_map` tool (flowgo) or falls
back to a static ```mermaid``` code block when asked to "map this out." Built
for brain#218, meant to pair with brain#212 (trigger-word copy in the tool
description/system prompt) — run this before and after a copy change to see
if it actually moves the win-rate, instead of guessing.

## Running it

Needs at least one provider API key in the environment:

```
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node eval/run.js
```

By default it runs every model in `MODEL_REGISTRY` (see `providers.js`).
Narrow it with `--models`:

```
node eval/run.js --models=claude-sonnet-5,gpt-5
```

or `EVAL_MODELS=claude-sonnet-5,gpt-5` if you'd rather set it via env.

Each run POSTs every prompt in `prompts.js` to every requested model, classifies
the response (`classify.js`), writes the raw rows to
`eval/results/<ISO-timestamp>.json`, and prints a scoreboard for that run.

A per-call failure (bad key, rate limit, network blip) is recorded as an
`"error"` verdict rather than crashing the whole matrix or being silently
folded into "the model chose neither" — `buildScoreboard` reports error counts
separately and excludes them from the rate denominators. If a model's row
shows `0/0` totals, check stderr for what actually failed before trusting any
percentage next to it.

## Interpreting results over time

```
node eval/scoreboard.js
```

reads every committed run under `eval/results/` and prints, per model, the
positive-prompt flowgo win-rate across runs in chronological order — so a
copy change (brain#212) or a model upgrade shows up as a visible trend line,
not just one snapshot you have to remember.

## Why commit results

`eval/results/*.json` files are checked in on purpose. The trend report only
works if past runs stick around — treat a run the same way you'd treat a
benchmark result: cheap to regenerate, but worth keeping so "did this get
better" has an answer.

## Adding a model

Add a row to `MODEL_REGISTRY` in `providers.js`: `{ provider, apiModel, envKey }`.
Anthropic- and OpenAI-shaped APIs need nothing else. A genuinely different
shape (Gemini, etc.) needs its own `call*`/`normalise*` pair in `providers.js`.

## Adding a prompt

Add a `{ id, category, text }` entry to `prompts.js`. `category` is
`"positive"` (a prompt that should plausibly trigger flowgo) or `"control"`
(an unrelated prompt — used to catch a model reaching for `create_map`
indiscriminately). Positive and control rates are reported separately on
purpose: a model that always calls `create_map` isn't "winning," it's broken.

## Tests

```
node --test './eval/*.test.js'
```

All provider/classify/run/scoreboard logic is unit-tested with fixtures and
an injectable fake model caller (`run({ callModelFn })`) — no network access
or API keys needed to run the suite.
