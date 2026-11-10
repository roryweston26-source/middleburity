// Runs a question on a non-Claude model through an OpenAI-style chat completions endpoint
// (OpenRouter, OpenAI, Gemini's and DeepSeek's compatible APIs, Cloudflare Workers AI...).
// Production runs DeepSeek this way, through OpenRouter, and the same path compares other models
// on the question set. Same tools, same system prompt, same Sources handling and lookup ceiling
// as the Claude path in chat.js; plain fetch, no SDK.
//
// Settings (wrangler.jsonc vars, or .dev.vars locally): MODEL (the provider's model name, e.g. "qwen/qwen3.7-flash"),
// OPENAI_COMPAT_BASE_URL (e.g. "https://openrouter.ai/api/v1") and OPENAI_COMPAT_API_KEY.
// Optional on OpenRouter: OPENROUTER_PROVIDER, the host (or comma-separated hosts) to use.
import { AnswerStream, statusFor } from "../answer-stream.js";
import { campusNowLabel } from "../campus-time.js";
import { MAX_ROUNDS, applySources, runLookup } from "../chat.js";
import { SYSTEM_PROMPT, timeContext } from "../prompt.js";
import { TOOL_DEFINITIONS, isDisplayOnly } from "../tools/index.js";

// A provider error, with the HTTP status so the worker can say what went wrong.
export class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const LAST_ROUND = "(From the app, not the student: no more lookups are available for this question. Answer now from the results above, and say what you couldn't find.)";

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
    // Hidden thinking, already counted in output_tokens.
    ...(typeof u.completion_tokens_details?.reasoning_tokens === "number" && { reasoning_tokens: u.completion_tokens_details.reasoning_tokens }),
    ...(typeof u.cost === "number" && { cost_usd: u.cost }),
  };
}

// REASONING (wrangler.jsonc var, or --reasoning= locally) sets how much the model thinks on
// OpenRouter: "low", "medium" or "high", or "none" to turn it off. Unset leaves the model's default.
export function reasoningSetting(value) {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "none" || v === "off") return { enabled: false };
  if (["minimal", "low", "medium", "high"].includes(v)) return { effort: v };
  throw new ProviderError(503, `REASONING must be none, minimal, low, medium or high, not "${value}"`);
}

function addUsage(total, u) {
  for (const [k, v] of Object.entries(u)) total[k] = (total[k] ?? 0) + v;
}

// With onText, the reply is streamed (server-sent events) and each piece of answer text is
// passed on as it arrives; the return value has the same shape as a non-streamed reply.
async function complete(env, body, fetchImpl, onText) {
  const base = (env.OPENAI_COMPAT_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !env.OPENAI_COMPAT_API_KEY) throw new ProviderError(503, "OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_API_KEY aren't set");
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_COMPAT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(onText ? { ...body, stream: true } : body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new ProviderError(res.status, `model provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return onText ? readStream(res, onText) : res.json();
}

// Rebuilds a streamed reply: text pieces, tool calls sent in fragments by index, and the usage
// OpenRouter puts in the last chunk. Lines starting with ":" are keep-alive comments.
export async function readStream(res, onText) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const calls = [];
  let buffer = "";
  let content = "";
  let model;
  let usage;
  let finish;
  const take = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    // A provider that fails partway sends an error chunk instead of closing cleanly.
    if (chunk.error) {
      const status = Number(chunk.error.code) || 502;
      throw new ProviderError(status, `model provider stream error: ${String(chunk.error.message ?? "").slice(0, 200)}`);
    }
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onText(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      const call = (calls[part.index ?? calls.length] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
    }
  }
  take(buffer.trim());
  const toolCalls = calls.filter(Boolean);
  return {
    model,
    usage,
    choices: [{ message: { role: "assistant", content, ...(toolCalls.length && { tool_calls: toolCalls }) }, finish_reason: finish }],
  };
}

// onEvent (optional) streams progress to the page: { type: "text", text } as the answer is
// written, "reset" when text already shown turns out to come with lookups, and
// { type: "status", text } while lookups run. Without it, replies aren't streamed.
export async function answerWithOpenAICompatible(history, { env = {}, model, now = new Date(), fetchImpl = fetch, onEvent } = {}) {
  const messages = [{ role: "system", content: `${SYSTEM_PROMPT}\n\n${timeContext(campusNowLabel(now))}` }, ...history];
  const functions = toFunctionTools(TOOL_DEFINITIONS);
  // OpenRouter reports each request's cost when asked; other providers would reject the field.
  // It also skips hosts that train on or keep prompts, and OPENROUTER_PROVIDER (e.g. "DeepInfra")
  // pins one host with no fallback, so a round isn't spread across differently quantized copies.
  const pinned = (env.OPENROUTER_PROVIDER ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const reasoning = reasoningSetting(env.REASONING);
  const extra = /openrouter\.ai/.test(env.OPENAI_COMPAT_BASE_URL ?? "")
    ? {
        usage: { include: true },
        ...(reasoning && { reasoning }),
        provider: { data_collection: "deny", require_parameters: true, ...(pinned.length && { order: pinned, allow_fallbacks: false }) },
      }
    : {};
  const cards = [];
  const usage = {};
  const tools = [];
  // Where each round's time went: waiting on the model, then on the lookups it asked for.
  const rounds = [];
  const since = (t) => Math.round((Date.now() - t) / 100) / 10;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // The last round sends no tools and says so, so the model answers from what it has. Neither
    // tool_choice "none" nor leaving the tools out was enough on its own: in testing Gemini 3.8
    // Flash asked for another lookup anyway.
    const last = round === MAX_ROUNDS - 1;
    if (last) messages.push({ role: "user", content: LAST_ROUND });
    const lookups = last ? {} : { tools: functions, tool_choice: "auto" };
    const asked = Date.now();
    const shown = onEvent ? new AnswerStream((text) => onEvent({ type: "text", text })) : null;
    const data = await complete(env, { model, messages, ...lookups, max_tokens: 16000, ...extra }, fetchImpl, shown && ((t) => shown.push(t)));
    const used = mapUsage(data.usage);
    addUsage(usage, used);
    const timing = { model_s: since(asked), output: used.output_tokens, ...(used.reasoning_tokens !== undefined && { reasoning: used.reasoning_tokens }) };
    rounds.push(timing);
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
        rounds,
        model: data.model ?? model,
        // Thinking models spend output tokens on hidden reasoning, which can cut the answer off.
        ...(choice?.finish_reason === "length" && { truncated: true }),
      };
    }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    tools.push(...calls.map((c) => c.function?.name));
    if (onEvent) {
      // Text written alongside lookups ("Let me check…") isn't the answer, unless it's the
      // office-links shortcut below; the finished answer replaces it either way.
      if (shown.started) onEvent({ type: "reset" });
      onEvent({ type: "status", text: statusFor(calls.map((c) => c.function?.name)) });
    }
    const looked = Date.now();
    const results = await Promise.all(
      calls.map(async (call) => {
        let input;
        try {
          input = JSON.parse(call.function?.arguments || "{}");
        } catch {
          return { call, out: { content: "That lookup failed: the tool input wasn't valid JSON.", isError: true } };
        }
        return { call, out: await runLookup(call.function?.name, input, env, tools) };
      }),
    );
    for (const { out } of results) if (out.card) cards.push(out.card);
    timing.lookups_s = since(looked);

    // Same shortcut as chat.js: an answer written alongside office links only is the answer.
    if (text && calls.every((c) => isDisplayOnly(c.function?.name)) && !results.some(({ out }) => out.searchFirst)) {
      return { ...applySources(text, cards), usage, tools, rounds, model: data.model ?? model };
    }
    for (const { call, out } of results) messages.push({ role: "tool", tool_call_id: call.id, content: out.content });
  }

  return {
    answer: "That took more lookups than I allow for one question. Try asking something narrower.",
    cards: applySources("", cards).cards,
    usage,
    tools,
    rounds,
    model,
  };
}
