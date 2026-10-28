import assert from "node:assert/strict";
import { test } from "node:test";
import { openLocalD1 } from "../src/db/node-d1.js";
import { answerCounts, countUsage, questionCounts } from "../src/stats.js";
import worker from "../src/worker.js";

const now = new Date("2026-10-27T15:00:00Z");
const all = (db) => db.prepare("SELECT day, what, n FROM stats ORDER BY what").all().then((r) => r.results.map((x) => ({ ...x })));

test("a question counts a visitor and a return only on their first question of the day", () => {
  assert.deepEqual(questionCounts({ firstToday: true, returning: true, followUp: false }), ["questions", "visitors", "returning"]);
  assert.deepEqual(questionCounts({ firstToday: false, returning: true, followUp: true }), ["questions", "follow-ups"]);
  // Only a real true from the page counts as returning.
  assert.deepEqual(questionCounts({ firstToday: true, returning: "yes", followUp: false }), ["questions", "visitors"]);
});

test("an answer counts each kind of lookup once", () => {
  assert.deepEqual(answerCounts(["search_pages", "search_pages", "get_menu"]), ["answered", "tool search_pages", "tool get_menu"]);
  assert.deepEqual(answerCounts([]), ["answered", "no lookup"]);
});

test("counts add up per day, in campus time", async () => {
  const db = openLocalD1();
  await countUsage(db, ["questions", "visitors"], now);
  await countUsage(db, ["questions"], now);
  // 1 a.m. UTC is still the evening before in Vermont.
  await countUsage(db, ["questions"], new Date("2026-10-28T01:00:00Z"));
  assert.deepEqual(await all(db), [
    { day: "2026-10-27", what: "questions", n: 3 },
    { day: "2026-10-27", what: "visitors", n: 1 },
  ]);
});

test("a count that can't be saved doesn't throw", async () => {
  const broken = { prepare: () => ({ run: () => Promise.reject(new Error("db down")) }) };
  const quiet = console.error;
  console.error = () => {};
  try {
    await countUsage(broken, ["questions"], now);
  } finally {
    console.error = quiet;
  }
});

test("the server counts questions without keeping any of their text", async () => {
  const db = openLocalD1();
  const env = { ANTHROPIC_API_KEY: "test", DB: db };
  const ask = (body) =>
    worker.fetch(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.4" },
        body: JSON.stringify(body),
      }),
      env,
    );
  // Both are counted, then refused before the model (the last turn isn't a question).
  const turn = { role: "assistant", content: "secret-question-text" };
  assert.equal((await ask({ messages: [turn], returning: true })).status, 400);
  assert.equal((await ask({ messages: [turn, turn], returning: true })).status, 400);
  const rows = await all(db);
  const n = (what) => rows.find((r) => r.what === what)?.n;
  assert.equal(n("questions"), 2);
  assert.equal(n("visitors"), 1);
  assert.equal(n("returning"), 1);
  assert.equal(n("follow-ups"), 1);
  assert.ok(!JSON.stringify(rows).includes("secret"));
  const columns = (await db.prepare("SELECT name FROM pragma_table_info('stats')").all()).results.map((c) => c.name);
  assert.deepEqual(columns, ["day", "what", "n"]);
});
