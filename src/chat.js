// One question in, one answer out: the model decides which sources to check, we run
// the lookups, and the loop ends when it has an answer.
import Anthropic from "@anthropic-ai/sdk";
import { campusNowLabel } from "./campus-time.js";
import { SYSTEM_PROMPT, timeContext } from "./prompt.js";
import { TOOL_DEFINITIONS, isDisplayOnly, runTool } from "./tools/index.js";
import { answerWithOpenAICompatible } from "./providers/openai-compatible.js";

export const DEFAULT_MODEL = "claude-opus-5";
export const MAX_ROUNDS = 5; // lookups per question; a cost ceiling as much as a sanity check
const MAX_TURNS = 12;
const MAX_CHARS = 2000;

export class ChatInputError extends Error {}

// The browser sends plain text turns only. Anything else is rejected, not repaired.
export function cleanHistory(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new ChatInputError("Send at least one message.");
  const turns = raw.slice(-MAX_TURNS).map((t) => {
    if (!t || (t.role !== "user" && t.role !== "assistant") || typeof t.content !== "string") {
      throw new ChatInputError("Each message needs a role and some text.");
    }
    return { role: t.role, content: t.content.trim().slice(0, MAX_CHARS) };
  });
  const kept = turns.filter((t) => t.content);
  while (kept.length && kept[0].role !== "user") kept.shift();
  if (!kept.length || kept.at(-1).role !== "user") throw new ChatInputError("The last message has to be a question.");
  return kept;
}

// Effort and server-side refusal fallbacks aren't available on every model.
export function modelOptions(model, effort) {
  if (model.startsWith("claude-haiku")) return {};
  const options = { output_config: { effort: effort || "low" } };
  if (model === "claude-opus-5" || model.startsWith("claude-fable-5")) {
    options.betas = ["server-side-fallback-2026-07-01"];
    options.fallbacks = "default";
  }
  return options;
}

// After a server-side fallback, blocks the declining model produced before the switch
// must not be echoed back; text and everything after the last switch point are kept.
export function contentToEcho(content) {
  const lastSwitch = content.findLastIndex((b) => b.type === "fallback");
  if (lastSwitch === -1) return content;
  const internal = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);
  return content.filter((b, i) => i > lastSwitch || !internal.has(b.type));
}

function textOf(content) {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// Several page searches in one answer become one "pages checked" card, not a stack of them,
// and a lookup the model made twice shows its card once.
export function mergeCards(cards) {
  const seenCards = new Set();
  const unique = cards.filter((c) => {
    const k = JSON.stringify(c);
    return !seenCards.has(k) && seenCards.add(k);
  });
  const pages = unique.filter((c) => c.type === "pages");
  if (pages.length < 2) return unique;
  const seen = new Set();
  const merged = { ...pages[0], pages: pages.flatMap((c) => c.pages).filter((p) => !seen.has(p.url) && seen.add(p.url)) };
  return [...unique.filter((c) => c.type !== "pages"), merged];
}

// The model ends an answer that used Middlebury's pages with "Sources: <url>, <url>" (or
// "Sources: none"). That line comes off the answer, and the pages card keeps just those
// pages, at most three, in the order cited. Only pages a search actually returned can be
// shown, so the card is still the search's own data. Without the line, the top three stay.
const MAX_SOURCES = 3;
const sameUrl = (u) => u.trim().replace(/[)>\].,;]+$/, "").replace(/\/+$/, "").toLowerCase();

// The Sources block: the last "Sources:" line, plus any lines after it that hold only links
// (the model often puts each address on its own line, sometimes as a "- " list).
function splitSources(answer) {
  const lines = answer.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const head = lines[i].match(/^\s*[-*]?\s*\**sources?\**:\**\s*(.*)$/i);
    if (!head) continue;
    const rest = lines.slice(i + 1);
    if (!rest.every((l) => /^\s*(?:[-*•]\s*)?(?:<?https?:\/\/\S+>?[\s,]*)*$/.test(l))) return { text: answer, cited: null };
    return { text: lines.slice(0, i).join("\n").trimEnd(), cited: [head[1], ...rest].join(" ") };
  }
  return { text: answer, cited: null };
}

export function applySources(answer, cards) {
  const { text, cited } = splitSources(answer);
  const merged = mergeCards(cards);
  const pagesCard = merged.find((c) => c.type === "pages");
  if (!pagesCard) return { answer: text, cards: merged };
  let keep = pagesCard.pages.slice(0, MAX_SOURCES);
  if (cited !== null) {
    const byUrl = new Map(pagesCard.pages.map((p) => [sameUrl(p.url), p]));
    const urls = [...new Set((cited.match(/https?:\/\/[^\s,<>]+/g) ?? []).map(sameUrl))];
    keep = urls.map((u) => byUrl.get(u)).filter(Boolean).slice(0, MAX_SOURCES);
  }
  const rest = merged.filter((c) => c.type !== "pages");
  return { answer: text, cards: keep.length ? [...rest, { ...pagesCard, pages: keep }] : rest };
}

function addUsage(total, usage = {}) {
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    total[key] = (total[key] ?? 0) + (usage[key] ?? 0);
  }
}

export async function answerQuestion(history, { env = {}, client, now = new Date() } = {}) {
  const model = env.MODEL || DEFAULT_MODEL;
  const messages = cleanHistory(history);
  // Claude always goes through Anthropic's SDK. Other models (for comparison testing) go
  // through an OpenAI-style endpoint set in OPENAI_COMPAT_BASE_URL.
  if (!model.startsWith("claude-")) return answerWithOpenAICompatible(messages, { env, model, now });
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const options = modelOptions(model, env.EFFORT);
  const cards = [];
  const usage = {};
  const tools = []; // names of the lookups made, in order, for grading test rounds

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: timeContext(campusNowLabel(now)) },
      ],
      tools: TOOL_DEFINITIONS,
      messages,
      ...options,
    });
    addUsage(usage, response.usage);

    if (response.stop_reason === "refusal") {
      return { answer: "Sorry, that's not something I can help with.", cards: applySources("", cards).cards, usage, tools, model: response.model };
    }

    if (response.stop_reason === "tool_use" || response.stop_reason === "pause_turn") {
      const echoed = contentToEcho(response.content);
      messages.push({ role: "assistant", content: echoed });
      const calls = echoed.filter((b) => b.type === "tool_use");
      if (!calls.length) continue;
      tools.push(...calls.map((c) => c.name));
      // Every result goes back in one message, in the order the calls were made.
      const results = await Promise.all(
        calls.map(async (call) => {
          const out = await runTool(call.name, call.input, env);
          return { call, out };
        }),
      );
      for (const { out } of results) if (out.card) cards.push(out.card);

      // The model wrote its answer and only asked for office links: that text is the answer.
      // Asking it to go again just produces a second, usually thinner, draft.
      const draft = textOf(echoed);
      if (draft && calls.every((call) => isDisplayOnly(call.name))) {
        return { ...applySources(draft, cards), usage, tools, model: response.model };
      }

      messages.push({
        role: "user",
        content: results.map(({ call, out }) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: out.content,
          ...(out.isError && { is_error: true }),
        })),
      });
      continue;
    }

    const answer = textOf(response.content);
    const final = applySources(answer, cards);
    return {
      answer: final.answer || "Sorry, I came up empty on that one.",
      cards: final.cards,
      usage,
      tools,
      model: response.model,
      ...(response.stop_reason === "max_tokens" && { truncated: true }),
    };
  }

  return {
    answer: "That took more lookups than I allow for one question. Try asking something narrower.",
    cards: applySources("", cards).cards,
    usage,
    tools,
    model,
  };
}
