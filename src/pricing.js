// Estimated cost of an answer, for the daily spending cap. USD per million tokens.
// Anthropic's list prices as of 2026-09 (the Claude API reference, cached 2026-06-24, and
// Legerly's prices.json, verified against Anthropic's pricing page 2026-09-19).
// Prompt caching bills cache writes at 1.25x input and cache reads at 0.1x input.
// An unknown model is priced as the most expensive one here, so the cap errs toward stopping early.
export const PRICES = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 }, // the server-side refusal fallback
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function estimateUsd(model, usage = {}) {
  // Some providers (OpenRouter) report what a request actually cost; that beats any estimate.
  if (typeof usage.cost_usd === "number") return usage.cost_usd;
  const price = PRICES[model] ?? PRICES["claude-opus-5"];
  const perToken = (rate) => rate / 1_000_000;
  return (
    (usage.input_tokens ?? 0) * perToken(price.input) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(price.input * 1.25) +
    (usage.cache_read_input_tokens ?? 0) * perToken(price.input * 0.1) +
    (usage.output_tokens ?? 0) * perToken(price.output)
  );
}
