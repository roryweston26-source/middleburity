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
        { type: "text", text: "Call 911 first. Public Safety can help on campus too." },
        { type: "tool_use", id: "o1", name: "get_office", input: { id: "public-safety" } },
      ],
    },
  ]);
  const result = await answerQuestion([{ role: "user", content: "My friend won't wake up" }], { client, now });
  assert.equal(client.requests.length, 1);
  assert.equal(result.answer, "Call 911 first. Public Safety can help on campus too.");
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
        { type: "tool_use", id: "o1", name: "get_office", input: { id: "public-safety" } },
      ],
    },
    { stop_reason: "end_turn", model: "claude-opus-5", usage, content: [{ type: "text", text: "Proctor has lamb." }] },
  ]);
  const result = await answerQuestion([{ role: "user", content: "dinner and hours?" }], { client, now });
  assert.equal(client.requests.length, 2);
  assert.equal(result.answer, "Proctor has lamb.");
  assert.deepEqual(result.cards.map((c) => c.type).sort(), ["menu", "office"]);
});

test("an office referral before any page search is sent back to search first", async () => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [
        { type: "text", text: "I couldn't find that. ResLife handles it." },
        { type: "tool_use", id: "o1", name: "get_office", input: { id: "residential-life" } },
      ],
    },
    { stop_reason: "end_turn", model: "claude-opus-5", usage, content: [{ type: "text", text: "Facilities takes repair requests." }] },
  ]);
  const result = await answerQuestion([{ role: "user", content: "My heater is broken" }], { client, now });
  assert.equal(client.requests.length, 2);
  const [sent] = client.requests[1].messages.at(-1).content;
  assert.equal(sent.is_error, true);
  assert.match(sent.content, /search_pages/);
  assert.equal(result.answer, "Facilities takes repair requests.");
  assert.deepEqual(result.cards, []);
});

test("a map search before any page search is sent back to search first", async () => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [
        { type: "text", text: "Here's a map search." },
        { type: "tool_use", id: "m1", name: "get_map_search", input: { what: "bank" } },
      ],
    },
    { stop_reason: "end_turn", model: "claude-opus-5", usage, content: [{ type: "text", text: "Middlebury's page lists four banks." }] },
  ]);
  const result = await answerQuestion([{ role: "user", content: "where's a bank" }], { client, now });
  assert.equal(client.requests.length, 2);
  const [sent] = client.requests[1].messages.at(-1).content;
  assert.equal(sent.is_error, true);
  assert.match(sent.content, /search_pages before a map search/);
  assert.deepEqual(result.cards, []);
});

test("a map search after a page search is the answer's card, with no second model call", async () => {
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [{ type: "tool_use", id: "s1", name: "search_pages", input: { query: "barber haircut" } }],
    },
    {
      stop_reason: "tool_use",
      model: "claude-opus-5",
      usage,
      content: [
        { type: "text", text: "Middlebury's pages don't list barbers. Here's a map search." },
        { type: "tool_use", id: "m1", name: "get_map_search", input: { what: "barber" } },
      ],
    },
  ]);
  const result = await answerQuestion([{ role: "user", content: "haircut?" }], { client, now });
  assert.equal(client.requests.length, 2);
  assert.equal(result.answer, "Middlebury's pages don't list barbers. Here's a map search.");
  assert.deepEqual(result.cards.map((c) => c.type), ["mapsearch"]);
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
  // The last round asks for an answer with no more lookups; only a model that ignores that
  // gets the ceiling message.
  assert.deepEqual(client.requests[4].tool_choice, { type: "none" });
  assert.equal(client.requests[3].tool_choice, undefined);
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

test("an answer that ends in a map search shows no pages unless it cites some", () => {
  const map = { type: "mapsearch", what: "pharmacy", place: "Middlebury, VT", url: "https://www.google.com/maps/search/?api=1&query=x" };
  assert.deepEqual(applySources("The pages don't list one; here's a map search.", [pagesCard(A, B), map]).cards, [map]);
  const cited = applySources(`Health and Wellness can transfer prescriptions.\nSources: ${B}`, [pagesCard(A, B), map]);
  assert.deepEqual(cited.cards.at(-1).pages.map((p) => p.url), [B]);
});

// Shapes the model actually used in the 2026-09-23 round.
test("a Sources block with each address on its own line comes off the answer too", () => {
  const P = "https://www.middlebury.edu/public-safety/parking-information/visitor-parking-information";
  const R = "https://www.middlebury.edu/residential-life/housing-overview/housing-resources";
  const answer = `Register her car with Public Safety.\n\nSources:\n${P}\n${R}`;
  const out = applySources(answer, [pagesCard(A, P, R, B)]);
  assert.equal(out.answer, "Register her car with Public Safety.");
  assert.deepEqual(out.cards[0].pages.map((p) => p.url), [P, R]);
});

test("a Sources block that starts on the Sources line and continues below, or as a list, is read whole", () => {
  const inline = applySources(`Everything runs through MiddPresence.\n\nSources: ${A}\n${B}`, [pagesCard(A, B, C)]);
  assert.equal(inline.answer, "Everything runs through MiddPresence.");
  assert.deepEqual(inline.cards[0].pages.map((p) => p.url), [A, B]);
  const listed = applySources(`Answer.\n\n**Sources:**\n- ${C}\n- <${A}>`, [pagesCard(A, B, C)]);
  assert.equal(listed.answer, "Answer.");
  assert.deepEqual(listed.cards[0].pages.map((p) => p.url), [C, A]);
});

test("a 'Sources' word inside the answer isn't mistaken for the block", () => {
  const text = "Sources: the Dining page says 4:30-8pm.\nThat's seven days a week.";
  assert.equal(applySources(text, [pagesCard(A)]).answer, text);
});

test("the same card twice (the model asked twice) shows once", () => {
  const trip = { type: "trips", from: "Middlebury", to: "Boston", trips: [] };
  assert.equal(applySources("Answer.", [trip, { ...trip }]).cards.length, 1);
});

test("a Sources line at the end of a sentence, mid-answer, or twice still comes off", () => {
  assert.equal(applySources("Plenty of options today. Sources: none", [pagesCard(A)]).answer, "Plenty of options today.");
  const mid = applySources("No posted hours for today.\n\nSources: none\n\nDining Services would know.", [pagesCard(A)]);
  assert.equal(mid.answer, "No posted hours for today.\n\nDining Services would know.");
  const twice = applySources(`Register the car.\n\nSources: ${A}\nSources: ${B}`, [pagesCard(A, B, C)]);
  assert.equal(twice.answer, "Register the car.");
  assert.deepEqual(twice.cards[0].pages.map((p) => p.url), [A, B]);
});

test("a Sources line that starts with a link and turns into prose ends the answer there", () => {
  const leaked = `PALANA has Salsa Night tonight, 7:00–8:25 PM.\n\nSources: https://example.com/event (Salsa Night listing) — hmm, I shouldn't invent links. Actually the tool didn't give me addresses.\nSo write Sources: none.PALANA has Salsa Night tonight.`;
  const out = applySources(leaked, [pagesCard(A)]);
  assert.equal(out.answer, "PALANA has Salsa Night tonight, 7:00–8:25 PM.");
  // A real Sources line with a cited page still works.
  assert.deepEqual(applySources(`Answer.\n\nSources: ${A} (the dining page)`, [pagesCard(A, B)]).cards[0].pages.map((p) => p.url), [A]);
});
