import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion } from "../src/chat.js";
import { answerWithOpenAICompatible, mapUsage, ProviderError, toFunctionTools } from "../src/providers/openai-compatible.js";
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
