import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ChatInputError, answerQuestion, applySources, cleanHistory, contentToEcho, modelOptions } from "../src/chat.js";
import { clearDiningCache } from "../src/tools/dining.js";
import { stubMenuFeed } from "./helpers.js";

beforeEach(() => clearDiningCache());

// A stand-in for the Anthropic client that replays canned responses and records requests.
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        async create(params) {
          requests.push(structuredClone(params));
          return responses.shift();
        },
      },
    },
  };
}

const usage = { input_tokens: 100, output_tokens: 20 };
const now = new Date("2026-09-21T22:00:00Z");

test("runs the menu lookup the model asks for, then returns its answer and a card", async (t) => {
  stubMenuFeed(t);
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [
        { type: "text", text: "Checking the menus." },
        { type: "tool_use", id: "call_1", name: "get_dining_menu", input: { date: "2026-09-21", meal: "dinner" } },
      ],
    },
    {
      stop_reason: "end_turn",
      model: "claude-opus-5",
      usage,
      content: [{ type: "text", text: "Nobody's doing Chinese tonight. Proctor is Middle Eastern." }],
    },
  ]);

  const result = await answerQuestion([{ role: "user", content: "Where's Chinese food tonight?" }], { client, now });

  assert.equal(result.answer, "Nobody's doing Chinese tonight. Proctor is Middle Eastern.");
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].type, "menu");
  assert.deepEqual(result.usage, { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

  const [first, second] = client.requests;
  assert.equal(first.model, "claude-opus-5");
  assert.equal(first.fallbacks, "default");
  assert.deepEqual(first.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(first.system[0].cache_control, { type: "ephemeral" });
  assert.match(first.system[1].text, /Monday, September 21, 2026.*6:00 PM/);
  const toolTurn = second.messages.at(-1);
  assert.equal(toolTurn.role, "user");
  assert.equal(toolTurn.content[0].type, "tool_result");
  assert.equal(toolTurn.content[0].tool_use_id, "call_1");
  assert.match(toolTurn.content[0].content, /Main Street/);
});

test("an answer written alongside an office lookup is kept, with no second model call", async () => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [
        { type: "text", text: "I can't check meal plans yet. Dining Services handles them." },
        { type: "tool_use", id: "o1", name: "get_office", input: { id: "dining" } },
      ],
    },
  ]);
  const result = await answerQuestion([{ role: "user", content: "How does my meal plan work?" }], { client, now });
  assert.equal(client.requests.length, 1);
  assert.equal(result.answer, "I can't check meal plans yet. Dining Services handles them.");
  assert.deepEqual(result.cards.map((c) => c.type), ["office"]);
});

test("an office lookup with no answer written yet goes back to the model", async () => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [{ type: "tool_use", id: "o1", name: "get_office", input: { id: "dining" } }],
    },
    { stop_reason: "end_turn", model: "claude-opus-5", usage, content: [{ type: "text", text: "Ask Dining Services." }] },
  ]);
  const result = await answerQuestion([{ role: "user", content: "meal plan?" }], { client, now });
  assert.equal(client.requests.length, 2);
  assert.equal(result.answer, "Ask Dining Services.");
});

test("a round that also needs menu data still goes back to the model", async (t) => {
  stubMenuFeed(t);
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "m1", name: "get_dining_menu", input: { meal: "dinner" } },
        { type: "tool_use", id: "o1", name: "get_office", input: { id: "dining" } },
      ],
    },
    { stop_reason: "end_turn", model: "claude-opus-5", usage, content: [{ type: "text", text: "Proctor has lamb." }] },
  ]);
  const result = await answerQuestion([{ role: "user", content: "dinner and hours?" }], { client, now });
  assert.equal(client.requests.length, 2);
  assert.equal(result.answer, "Proctor has lamb.");
  assert.deepEqual(result.cards.map((c) => c.type).sort(), ["menu", "office"]);
});

test("a refusal gets a plain apology instead of an empty answer", async () => {
  const client = fakeClient([{ stop_reason: "refusal", model: "claude-opus-5", usage, content: [] }]);
  const result = await answerQuestion([{ role: "user", content: "hi" }], { client, now });
  assert.match(result.answer, /not something I can help with/);
});

test("the lookup loop has a ceiling", async (t) => {
  stubMenuFeed(t);
  const looping = () => ({
    stop_reason: "tool_use",
    model: "claude-opus-5",
    usage,
    content: [{ type: "tool_use", id: `c${Math.random()}`, name: "get_dining_menu", input: {} }],
  });
  const client = fakeClient(Array.from({ length: 10 }, looping));
  const result = await answerQuestion([{ role: "user", content: "menus?" }], { client, now });
  assert.equal(client.requests.length, 5);
  assert.match(result.answer, /more lookups than I allow/);
});

test("cleanHistory accepts plain turns and rejects anything else", () => {
  assert.deepEqual(cleanHistory([{ role: "assistant", content: "hi" }, { role: "user", content: " q " }]), [
    { role: "user", content: "q" },
  ]);
  assert.throws(() => cleanHistory([]), ChatInputError);
  assert.throws(() => cleanHistory([{ role: "system", content: "x" }]), ChatInputError);
  assert.throws(() => cleanHistory([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]), ChatInputError);
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  long.push({ role: "user", content: "last" });
  assert.ok(cleanHistory(long).length <= 12);
});

test("after a fallback, the declined model's internal blocks aren't echoed back", () => {
  const content = [
    { type: "tool_use", id: "x" },
    { type: "text", text: "partial" },
    { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-opus-4-8" } },
    { type: "tool_use", id: "y" },
  ];
  assert.deepEqual(
    contentToEcho(content).map((b) => b.id ?? b.type),
    ["text", "fallback", "y"],
  );
});

test("model options only use features the model has", () => {
  assert.deepEqual(modelOptions("claude-haiku-4-5"), {});
  assert.deepEqual(modelOptions("claude-sonnet-5"), { output_config: { effort: "low" } });
  assert.equal(modelOptions("claude-opus-5", "medium").output_config.effort, "medium");
});

const pagesCard = (...urls) => ({ type: "pages", pages: urls.map((url) => ({ title: url, url })), source: { label: "middlebury.edu" } });
const A = "https://www.middlebury.edu/a";
const B = "https://www.middlebury.edu/b";
const C = "https://www.middlebury.edu/c";
const D = "https://www.middlebury.edu/d";

test("the Sources line comes off the answer, and the card keeps just those pages, in order", () => {
  const out = applySources(`The Mail Center is in McCullough.\n\nSources: ${C}, ${A}/`, [pagesCard(A, B), pagesCard(C, D)]);
  assert.equal(out.answer, "The Mail Center is in McCullough.");
  assert.deepEqual(out.cards[0].pages.map((p) => p.url), [C, A]);
});

test("only pages a search returned can be shown, and never more than three", () => {
  const out = applySources(`Answer.\n**Sources:** ${A}, https://example.com/made-up, ${B}, ${C}, ${D}`, [pagesCard(A, B, C, D)]);
  assert.deepEqual(out.cards[0].pages.map((p) => p.url), [A, B, C]);
});

test("'Sources: none' drops the pages card; a missing line keeps the top three", () => {
  const menu = { type: "menu" };
  assert.deepEqual(applySources("Nothing on the site.\nSources: none", [menu, pagesCard(A, B)]).cards, [menu]);
  const missing = applySources("An answer with no Sources line.", [pagesCard(A, B, C, D)]);
  assert.equal(missing.answer, "An answer with no Sources line.");
  assert.equal(missing.cards[0].pages.length, 3);
});
