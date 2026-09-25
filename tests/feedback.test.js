import assert from "node:assert/strict";
import { test } from "node:test";
import { openLocalD1 } from "../src/db/node-d1.js";
import { MAX_PER_DAY, cleanFeedback, saveFeedback } from "../src/feedback.js";
import worker from "../src/worker.js";

const now = new Date("2026-09-25T20:00:00Z");
const good = {
  rating: "down",
  question: "whats the best place for a haircut men",
  answer: "Middlebury's pages don't list barbers.",
  note: "should have given me a map",
  context: [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }],
  tools: ["search_pages", "get_map_search"],
  cards: ["mapsearch"],
  model: "deepseek/deepseek-v4.1-flash",
};

const send = (env, { code, body = JSON.stringify(good) } = {}) =>
  worker.fetch(
    new Request("http://localhost/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9", ...(code && { "x-access-code": code }) },
      body,
    }),
    env,
  );

test("feedback keeps the rating and what the tester sent, and nothing about who sent it", async () => {
  const db = openLocalD1();
  assert.equal((await send({ DB: db })).status, 200);
  const row = await db.prepare("SELECT * FROM feedback").first();
  assert.equal(row.rating, "down");
  assert.equal(row.question, good.question);
  assert.equal(row.note, good.note);
  assert.equal(row.tools, "search_pages > get_map_search");
  assert.equal(row.cards, "mapsearch");
  assert.deepEqual(JSON.parse(row.context), good.context);
  assert.deepEqual(Object.keys(row).sort(), ["answer", "at", "cards", "context", "id", "model", "note", "question", "rating", "tools"]);
  assert.ok(!JSON.stringify(row).includes("198.51.100.9"));
});

test("feedback needs the access code, a thumb, a question and an answer", async () => {
  const db = openLocalD1();
  assert.equal((await send({ DB: db, ACCESS_CODE: "maple" })).status, 401);
  assert.equal((await send({ DB: db, ACCESS_CODE: "maple" }, { code: "maple" })).status, 200);
  assert.equal((await send({ DB: db }, { body: JSON.stringify({ ...good, rating: "meh" }) })).status, 400);
  assert.equal((await send({ DB: db }, { body: JSON.stringify({ rating: "up", answer: "x" }) })).status, 400);
  assert.equal((await send({ DB: db }, { body: "not json" })).status, 400);
  assert.equal((await send({})).status, 503);
});

test("feedback is cut to size, and only the fields the page sends are kept", () => {
  const f = cleanFeedback({ ...good, rating: "up", question: "q".repeat(5000), context: Array(10).fill({ role: "user", content: "c" }), extra: "ignored", ip: "1.2.3.4" });
  assert.equal(f.rating, "up");
  assert.equal(f.question.length, 2000);
  assert.equal(JSON.parse(f.context).length, 4);
  assert.ok(!("ip" in f) && !("extra" in f));
  assert.equal(cleanFeedback({ rating: "up", question: "q", answer: "a" }).note, null);
});

test("old feedback is deleted after 60 days, and a day's feedback is capped", async () => {
  const db = openLocalD1();
  const f = cleanFeedback(good);
  await saveFeedback(db, f, new Date("2026-07-01T12:00:00Z"));
  await saveFeedback(db, f, now);
  assert.equal(await db.prepare("SELECT count(*) AS n FROM feedback").first("n"), 1);
  for (let i = 1; i < MAX_PER_DAY; i++) await saveFeedback(db, f, now);
  assert.equal((await saveFeedback(db, f, now)).ok, false);
});
