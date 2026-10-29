import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion } from "../src/chat.js";
import { answerWithOpenAICompatible, mapUsage, ProviderError, reasoningSetting, toFunctionTools } from "../src/providers/openai-compatible.js";
import { estimateUsd } from "../src/pricing.js";
import { installProbes, PROBE_CLUB, PROBE_EVENT } from "./probes.js";

const env = { OPENAI_COMPAT_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_COMPAT_API_KEY: "test-key" };
const now = new Date("2026-09-23T22:00:00Z");

// A stand-in for an OpenAI-style provider: replays canned replies and records requests.
function fakeProvider(replies) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const reply = replies.shift();
    return new Response(JSON.stringify(reply), { status: reply.status ?? 200 });
  };
  return { requests, fetchImpl };
}

test("tools are offered in the OpenAI function format, with the same schemas", () => {
  const [fn] = toFunctionTools([{ name: "get_x", description: "d", input_schema: { type: "object", properties: {} } }]);
  assert.deepEqual(fn, { type: "function", function: { name: "get_x", description: "d", parameters: { type: "object", properties: {} } } });
});

test("token counts map onto the same four meters, and a reported cost is used as is", () => {
  const u = mapUsage({ prompt_tokens: 7000, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 5000 }, cost: 0.0012 });
  assert.deepEqual(u, { input_tokens: 2000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 120, cost_usd: 0.0012 });
  assert.equal(estimateUsd("qwen/qwen3.7-flash", u), 0.0012);
});

test("a tool call runs, its result goes back, and the final answer's Sources line is handled", async () => {
  const { requests, fetchImpl } = fakeProvider([
    { model: "qwen/qwen3.7-flash", usage: { prompt_tokens: 100, completion_tokens: 10 },
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_horoscope", arguments: "{}" } }] } }] },
    { model: "qwen/qwen3.7-flash", usage: { prompt_tokens: 150, completion_tokens: 20 },
      choices: [{ message: { role: "assistant", content: "I couldn't find that.\n\nSources: none" } }] },
  ]);
  const out = await answerWithOpenAICompatible([{ role: "user", content: "What's my horoscope?" }], { env, model: "qwen/qwen3.7-flash", now, fetchImpl });
  assert.equal(out.answer, "I couldn't find that.");
  assert.deepEqual(out.tools, ["get_horoscope"]);
  assert.equal(out.usage.input_tokens, 250);
  // The second request carries the tool call and its (error) result, in OpenAI's shape.
  const second = requests[1].body.messages;
  assert.equal(second.at(-2).tool_calls[0].id, "c1");
  assert.equal(second.at(-1).role, "tool");
  assert.match(second.at(-1).content, /no tool called get_horoscope/i);
  // The system prompt goes first, and OpenRouter is asked to report cost.
  assert.equal(requests[0].body.messages[0].role, "system");
  assert.deepEqual(requests[0].body.usage, { include: true });
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
});

test("bad tool arguments come back to the model as an error, not a crash", async () => {
  const { requests, fetchImpl } = fakeProvider([
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: "{not json" } }] } }] },
    { choices: [{ message: { content: "Sorry." } }] },
  ]);
  await answerWithOpenAICompatible([{ role: "user", content: "Weather?" }], { env, model: "m", now, fetchImpl });
  assert.match(requests[1].body.messages.at(-1).content, /wasn't valid JSON/);
});

test("a provider error carries its status for the worker", async () => {
  const { fetchImpl } = fakeProvider([{ status: 401, error: "bad key" }]);
  await assert.rejects(answerWithOpenAICompatible([{ role: "user", content: "hi" }], { env, model: "m", now, fetchImpl }), (e) => e instanceof ProviderError && e.status === 401);
});

test("non-Claude model names route to the adapter; Claude names never do", async () => {
  await assert.rejects(answerQuestion([{ role: "user", content: "hi" }], { env: { MODEL: "gpt-5.6-luna" }, now }), /OPENAI_COMPAT_BASE_URL/);
});

test("test mode plants one event and one club in the Presence feeds, and nothing else", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes("events") ? [{ eventName: "Real" }] : String(url).includes("organizations") ? [{ name: "Real Club" }] : { other: true }));
  const plain = globalThis.fetch;
  const uninstall = installProbes(() => now);
  const events = await (await fetch("https://api.presence.io/middlebury/v1/events")).json();
  const clubs = await (await fetch("https://api.presence.io/middlebury/v1/organizations")).json();
  const other = await (await fetch("https://api.weather.gov/points/1,2")).json();
  uninstall();
  assert.deepEqual(events.map((e) => e.eventName), ["Real", PROBE_EVENT]);
  assert.deepEqual(clubs.map((c) => c.name), ["Real Club", PROBE_CLUB]);
  assert.deepEqual(other, { other: true });
  assert.equal(globalThis.fetch, plain, "uninstall puts the original fetch back");
});

test("OpenRouter requests skip hosts that keep prompts, and can pin one host", async () => {
  const reply = { choices: [{ message: { role: "assistant", content: "Hi." }, finish_reason: "stop" }], usage: {} };
  const open = fakeProvider([structuredClone(reply)]);
  await answerWithOpenAICompatible([{ role: "user", content: "hi" }], { env, model: "x/y", now, fetchImpl: open.fetchImpl });
  assert.deepEqual(open.requests[0].body.provider, { data_collection: "deny", require_parameters: true });

  const pinned = fakeProvider([structuredClone(reply)]);
  const pinEnv = { ...env, OPENROUTER_PROVIDER: "DeepInfra, Together" };
  await answerWithOpenAICompatible([{ role: "user", content: "hi" }], { env: pinEnv, model: "x/y", now, fetchImpl: pinned.fetchImpl });
  assert.deepEqual(pinned.requests[0].body.provider, { data_collection: "deny", require_parameters: true, order: ["DeepInfra", "Together"], allow_fallbacks: false });
});

test("a dated model id is priced as its alias", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(estimateUsd("claude-haiku-4-5-20251001", usage), estimateUsd("claude-haiku-4-5", usage));
  assert.equal(estimateUsd("claude-haiku-4-5", usage), 1);
});

test("the last round sends no tools and asks for an answer from what the model has", async () => {
  const lookup = () => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name: "get_office", arguments: '{"id":"public-safety"}' } }] }, finish_reason: "tool_calls" }], usage: {} });
  const answer = { choices: [{ message: { role: "assistant", content: "Sunny." }, finish_reason: "stop" }], usage: {} };
  const provider = fakeProvider([lookup(), lookup(), lookup(), lookup(), answer]);
  const result = await answerWithOpenAICompatible([{ role: "user", content: "weather?" }], { env, model: "x/y", now, fetchImpl: provider.fetchImpl });
  assert.equal(provider.requests.length, 5);
  assert.ok(provider.requests[3].body.tools);
  const last = provider.requests[4].body;
  assert.equal(last.tools, undefined);
  assert.equal(last.tool_choice, undefined);
  assert.match(last.messages.at(-1).content, /no more lookups/);
  assert.equal(result.answer, "Sunny.");
});

test("thinking tokens and each round's time are reported, for the runner", async () => {
  assert.equal(mapUsage({ completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 380 } }).reasoning_tokens, 380);
  assert.equal("reasoning_tokens" in mapUsage({ completion_tokens: 5 }), false);
  const { fetchImpl } = fakeProvider([
    { usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } },
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_horoscope", arguments: "{}" } }] } }] },
    { usage: { completion_tokens: 20 }, choices: [{ message: { content: "Nothing on that." } }] },
  ]);
  const out = await answerWithOpenAICompatible([{ role: "user", content: "Horoscope?" }], { env, model: "m", now, fetchImpl });
  assert.equal(out.rounds.length, 2);
  assert.equal(out.rounds[0].output, 40);
  assert.equal(out.rounds[0].reasoning, 30);
  assert.equal(typeof out.rounds[0].model_s, "number");
  assert.equal(typeof out.rounds[0].lookups_s, "number");
  assert.equal(out.rounds[1].lookups_s, undefined); // the answer round looks nothing up
  assert.equal(out.usage.reasoning_tokens, 30);
});

test("REASONING sets how much the model thinks on OpenRouter; unset sends nothing", async () => {
  assert.equal(reasoningSetting(undefined), null);
  assert.deepEqual(reasoningSetting("none"), { enabled: false });
  assert.deepEqual(reasoningSetting(" Low "), { effort: "low" });
  assert.throws(() => reasoningSetting("fast"), ProviderError);
  const reply = { choices: [{ message: { content: "Hi." } }], usage: {} };
  const plain = fakeProvider([structuredClone(reply)]);
  await answerWithOpenAICompatible([{ role: "user", content: "hi" }], { env, model: "m", now, fetchImpl: plain.fetchImpl });
  assert.equal("reasoning" in plain.requests[0].body, false);
  const low = fakeProvider([structuredClone(reply)]);
  await answerWithOpenAICompatible([{ role: "user", content: "hi" }], { env: { ...env, REASONING: "low" }, model: "m", now, fetchImpl: low.fetchImpl });
  assert.deepEqual(low.requests[0].body.reasoning, { effort: "low" });
});
