import assert from "node:assert/strict";
import { test } from "node:test";
import { openLocalD1 } from "../src/db/node-d1.js";
import { MAX_PER_DAY, cleanReport, saveReport } from "../src/reports.js";
import worker from "../src/worker.js";

const now = new Date("2026-09-25T20:00:00Z");
const good = {
  question: "whats the best place for a haircut men",
  answer: "Middlebury's pages don't list barbers.",
  note: "should have given me a map",
  context: [{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }],
  tools: ["search_pages", "get_map_search"],
  cards: ["mapsearch"],
  model: "deepseek/deepseek-v4.1-flash",
};

const report = (env, { code, body = JSON.stringify(good) } = {}) =>
  worker.fetch(
    new Request("http://localhost/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9", ...(code && { "x-access-code": code }) },
      body,
    }),
    env,
  );

test("a report keeps what the tester sent and nothing about who sent it", async () => {
  const db = openLocalD1();
  const res = await report({ DB: db });
  assert.equal(res.status, 200);
  const row = await db.prepare("SELECT * FROM reports").first();
  assert.equal(row.question, good.question);
  assert.equal(row.note, good.note);
  assert.equal(row.tools, "search_pages > get_map_search");
  assert.equal(row.cards, "mapsearch");
  assert.deepEqual(JSON.parse(row.context), good.context);
  assert.deepEqual(Object.keys(row).sort(), ["answer", "at", "cards", "context", "id", "model", "note", "question", "tools"]);
  assert.ok(!JSON.stringify(row).includes("198.51.100.9"));
});

test("reports need the access code, a question and an answer", async () => {
  const db = openLocalD1();
  assert.equal((await report({ DB: db, ACCESS_CODE: "maple" })).status, 401);
  assert.equal((await report({ DB: db, ACCESS_CODE: "maple" }, { code: "maple" })).status, 200);
  assert.equal((await report({ DB: db }, { body: JSON.stringify({ answer: "x" }) })).status, 400);
  assert.equal((await report({ DB: db }, { body: "not json" })).status, 400);
  assert.equal((await report({})).status, 503);
});

test("reports are cut to size, and only the fields the page sends are kept", () => {
  const r = cleanReport({ ...good, question: "q".repeat(5000), context: Array(10).fill({ role: "user", content: "c" }), extra: "ignored", ip: "1.2.3.4" });
  assert.equal(r.question.length, 2000);
  assert.equal(JSON.parse(r.context).length, 4);
  assert.ok(!("ip" in r) && !("extra" in r));
  assert.equal(cleanReport({ question: "q", answer: "a" }).note, null);
});

test("old reports are deleted after 60 days, and a day's reports are capped", async () => {
  const db = openLocalD1();
  const r = cleanReport(good);
  await saveReport(db, r, new Date("2026-07-01T12:00:00Z"));
  await saveReport(db, r, now);
  assert.equal(await db.prepare("SELECT count(*) AS n FROM reports").first("n"), 1);
  for (let i = 1; i < MAX_PER_DAY; i++) await saveReport(db, r, now);
  assert.equal((await saveReport(db, r, now)).ok, false);
});
