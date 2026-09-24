// Runs a question on a non-Claude model through an OpenAI-style chat completions endpoint
// (OpenRouter, OpenAI, Gemini's and DeepSeek's compatible APIs, Cloudflare Workers AI...), so
// other models can be compared on the same question set. Same tools, same system prompt, same
// Sources handling and lookup ceiling as the Claude path in chat.js; plain fetch, no SDK.
//
// Settings (in .dev.vars): MODEL (the provider's model name, e.g. "qwen/qwen3.7-flash"),
// OPENAI_COMPAT_BASE_URL (e.g. "https://openrouter.ai/api/v1") and OPENAI_COMPAT_API_KEY.
// Optional on OpenRouter: OPENROUTER_PROVIDER, the host (or comma-separated hosts) to use.
import { campusNowLabel } from "../campus-time.js";
import { MAX_ROUNDS, applySources } from "../chat.js";
import { SYSTEM_PROMPT, timeContext } from "../prompt.js";
import { TOOL_DEFINITIONS, isDisplayOnly, runTool } from "../tools/index.js";

// A provider error, with the HTTP status so the worker can say what went wrong.
export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const toFunctionTools = (defs) =>
  defs.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.input_schema } }));

// The provider's token counts in the same shape chat.js reports. OpenRouter also returns the
// request's actual cost, which beats estimating it from a price table.
export function mapUsage(u = {}) {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: u.completion_tokens ?? 0,
    ...(typeof u.cost === "number" && { cost_usd: u.cost }),
  };
}

function addUsage(total, u) {
  for (const [k, v] of Object.entries(u)) total[k] = (total[k] ?? 0) + v;
}

async function complete(env, body, fetchImpl) {
  const base = (env.OPENAI_COMPAT_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.OPENAI_COMPAT_API_KEY) throw new ProviderError(503, "OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY aren't set");
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_COMPAT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new ProviderError(res.status, `model provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function answerWithOpenAICompatible(history, { env = {}, model, now = new Date(), fetchImpl = fetch } = {}) {
  const messages = [{ role: "system", content: `${SYSTEM_PROMPT}\n\n${timeContext(campusNowLabel(now))}` }, ...history];
  const functions = toFunctionTools(TOOL_DEFINITIONS);
  // OpenRouter reports each request's cost when asked; other providers would reject the field.
  // It also skips hosts that train on or keep prompts, and OPENROUTER_PROVIDER (e.g. "DeepInfra")
  // pins one host with no fallback, so a round isn't spread across differently quantized copies.
  const pinned = (env.OPENROUTER_PROVIDER ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const extra = /openrouter\.ai/.test(env.OPENAI_COMPAT_BASE_URL ?? "")
    ? {
        usage: { include: true },
        provider: { data_collection: "deny", require_parameters: true, ...(pinned.length && { order: pinned, allow_fallbacks: false }) },
      }
    : {};
  const cards = [];
  const usage = {};
  const tools = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await complete(env, { model, messages, tools: functions, tool_choice: "auto", max_tokens: 16000, ...extra }, fetchImpl);
    addUsage(usage, mapUsage(data.usage));
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};
    const calls = message.tool_calls ?? [];
    const text = (typeof message.content === "string" ? message.content : "").trim();

    if (!calls.length) {
      const final = applySources(text, cards);
      return {
        answer: final.answer || "Sorry, I came up empty on that one.",
        cards: final.cards,
        usage,
        tools,
        model: data.model ?? model,
        // Thinking models spend output tokens on hidden reasoning, which can cut the answer off.
        ...(choice?.finish_reason === "length" && { truncated: true }),
      };
    }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    tools.push(...calls.map((c) => c.function?.name));
    const results = await Promise.all(
      calls.map(async (call) => {
        let input;
        try {
          input = JSON.parse(call.function?.arguments || "{}");
        } catch {
          return { call, out: { content: "That lookup failed: the tool input wasn't valid JSON.", isError: true } };
        }
        return { call, out: await runTool(call.function?.name, input, env) };
      }),
    );
    for (const { out } of results) if (out.card) cards.push(out.card);

    // Same shortcut as chat.js: an answer written alongside office links only is the answer.
    if (text && calls.every((c) => isDisplayOnly(c.function?.name))) {
      return { ...applySources(text, cards), usage, tools, model: data.model ?? model };
    }
    for (const { call, out } of results) messages.push({ role: "tool", tool_call_id: call.id, content: out.content });
  }

  return {
    answer: "That took more lookups than I allow for one question. Try asking something narrower.",
    cards: applySources("", cards).cards,
    usage,
    tools,
    model,
  };
}
