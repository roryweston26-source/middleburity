// Streaming answers to the page (2026-11-10): the Sources hold-back, rebuilding a streamed
// provider reply, and the /api/chat stream. Free: no network, no model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnswerStream, statusFor } from "../src/answer-stream.js";
import { answerWithOpenAICompatible, ProviderError } from "../src/providers/openai-compatible.js";
import worker from "../src/worker.js";

const env = { OPENAI_COMPAT_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_COMPAT_API_KEY: "test-key" };
const now = new Date("2026-09-23T22:00:00Z");

// A server-sent-events reply, cut into 7-byte pieces so lines arrive split across reads.
function sse(chunks) {
  const text = chunks.map((c) => (typeof c === "string" ? c : `data: ${JSON.stringify(c)}`)).join("\n\n") + "\n\ndata: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const say = (content) => ({ model: "m", choices: [{ delta: { content } }] });

function shown(pieces) {
  const out = [];
  const s = new AnswerStream((t) => out.push(t));
  for (const p of pieces) s.push(p);
  return out.join("").trimEnd(); // trailing spaces come and go; the page ignores them
}

test("the stream holds back the word being written and everything from a Sources line on", () => {
  assert.equal(shown(["Proctor serves", " dinner 4:30–8pm.\n\nSour", "ces: https://www.middlebury.edu/x"]), "Proctor serves dinner 4:30–8pm.");
  assert.equal(shown(["Open till midnight today. **Sources:** none"]), "Open till midnight today.");
  assert.equal(shown(["- **Sources", ":** https://a\n- https://b"]), "");
  // "resources:" isn't a Sources line.
  assert.equal(shown(["Two resources: TimelyCare and Counseling. "]), "Two resources: TimelyCare and Counseling.");
});

test("lookup status lines use plain words, never tool names", () => {
  assert.equal(statusFor(["search_pages", "search_pages", "get_dining_menu"]), "Searching Middlebury's pages, Checking dining menus");
  assert.equal(statusFor(["get_something_new"]), "Looking that up");
});

test("a streamed reply is rebuilt: tool calls in fragments, text, usage, and the Sources line handled", async () => {
  const requests = [];
  const replies = [
    sse([
      ": OPENROUTER PROCESSING",
      say("Let me check. "),
      { model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_horo", arguments: "" } }] } }] },
      { model: "m", choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "scope", arguments: '{"sign":' } }] } }] },
      { model: "m", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"leo"}' } }] }, finish_reason: "tool_calls" }] },
      { model: "m", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
    ]),
    sse([say("I couldn't "), say("find that.\n\nSources: none"), { model: "m", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 20 } }]),
  ];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return replies.shift();
  };
  const events = [];
  const out = await answerWithOpenAICompatible([{ role: "user", content: "Horoscope?" }], { env, model: "m", now, fetchImpl, onEvent: (e) => events.push(e) });

  assert.equal(requests[0].stream, true);
  assert.equal(out.answer, "I couldn't find that.");
  assert.deepEqual(out.tools, ["get_horoscope"]);
  assert.equal(out.usage.input_tokens, 250);
  // The tool call went back to the model whole.
  assert.equal(requests[1].messages.at(-2).tool_calls[0].function.arguments, '{"sign":"leo"}');
  // "Let me check." was shown, then taken back once the round turned into a lookup.
  const types = events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ["text", "reset", "status"]);
  const answerText = events.slice(3).filter((e) => e.type === "text").map((e) => e.text).join("");
  assert.equal(answerText.trimEnd(), "I couldn't find that.");
});

test("without onEvent nothing is streamed, as before", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "Hi." } }] }));
  };
  const out = await answerWithOpenAICompatible([{ role: "user", content: "Hi" }], { env, model: "m", now, fetchImpl });
  assert.equal(out.answer, "Hi.");
  assert.equal(requests[0].stream, undefined);
});

test("an error partway through a stream is a provider error", async () => {
  const fetchImpl = async () => sse([say("Proctor "), { error: { code: 502, message: "upstream died" } }]);
  await assert.rejects(
    answerWithOpenAICompatible([{ role: "user", content: "Hi" }], { env, model: "m", now, fetchImpl, onEvent: () => {} }),
    (err) => err instanceof ProviderError && err.status === 502,
  );
});

const chat = (body) =>
  worker.fetch(
    new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { ...env, MODEL: "deepseek/deepseek-v4.1-flash" },
  );

async function lines(res) {
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}

test("/api/chat streams one JSON object per line, ending with the finished answer", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = async () => sse([say("Proctor serves dinner "), say("4:30–8pm.\n\nSources: none"), { model: "m", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);

  const res = await chat({ messages: [{ role: "user", content: "When is Proctor dinner?" }], stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  const events = await lines(res);
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.answer, "Proctor serves dinner 4:30–8pm.");
  assert.ok(events.filter((e) => e.type === "text").every((e) => !/sources/i.test(e.text)));
});

test("/api/chat stream: a bad request is still a plain 400, and a failed model call ends in an error line", async (t) => {
  const bad = await chat({ messages: [], stream: true });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get("content-type"), /json/);

  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  const res = await chat({ messages: [{ role: "user", content: "Hi" }], stream: true });
  const events = await lines(res);
  assert.deepEqual(events.at(-1), { type: "error", status: 502, error: "The AI service had a problem. Try again in a moment." });
});

test("/api/chat without stream still answers with plain JSON", async (t) => {
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "Hi there." } }] }));
  const res = await chat({ messages: [{ role: "user", content: "Hi" }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).answer, "Hi there.");
});
