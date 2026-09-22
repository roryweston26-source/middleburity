import assert from "node:assert/strict";
import { test } from "node:test";
import { openLocalD1 } from "../src/db/node-d1.js";
import { admit, limitsFrom, recordSpend, spentToday, visitorId } from "../src/limits.js";
import { estimateUsd } from "../src/pricing.js";
import worker from "../src/worker.js";

const now = new Date("2026-09-22T15:00:00Z");

test("visitor codes are anonymous, stable within a day, and different the next day", async () => {
  const a = await visitorId("203.0.113.7", "2026-09-22", "salt");
  assert.equal(a, await visitorId("203.0.113.7", "2026-09-22", "salt"));
  assert.notEqual(a, await visitorId("203.0.113.7", "2026-09-23", "salt"));
  assert.notEqual(a, await visitorId("203.0.113.8", "2026-09-22", "salt"));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes("203"));
});

test("a visitor is stopped after the hourly limit", async () => {
  const db = openLocalD1();
  const limits = { perHour: 2, perDay: 10, dailyUsd: 5 };
  assert.equal((await admit(db, { visitor: "v1", limits, now })).ok, true);
  assert.equal((await admit(db, { visitor: "v1", limits, now })).ok, true);
  const third = await admit(db, { visitor: "v1", limits, now });
  assert.equal(third.status, 429);
  assert.match(third.error, /this hour/);
  // Someone else isn't affected.
  assert.equal((await admit(db, { visitor: "v2", limits, now })).ok, true);
  // An hour later the first visitor can ask again.
  assert.equal((await admit(db, { visitor: "v1", limits, now: new Date(now.getTime() + 3600e3) })).ok, true);
});

test("a visitor is stopped after the daily limit, and told how many are left", async () => {
  const db = openLocalD1();
  const limits = { perHour: 100, perDay: 2, dailyUsd: 5 };
  assert.equal((await admit(db, { visitor: "v", limits, now })).remainingToday, 1);
  assert.equal((await admit(db, { visitor: "v", limits, now })).remainingToday, 0);
  assert.match((await admit(db, { visitor: "v", limits, now })).error, /today/);
});

test("the daily spending cap stops everyone once it's reached", async () => {
  const db = openLocalD1();
  const limits = { perHour: 100, perDay: 100, dailyUsd: 0.05 };
  await recordSpend(db, 0.03, now);
  await recordSpend(db, 0.03, now);
  assert.ok(Math.abs((await spentToday(db, now)) - 0.06) < 1e-9);
  const blocked = await admit(db, { visitor: "anyone", limits, now });
  assert.equal(blocked.status, 503);
  assert.match(blocked.error, /spending limit/);
});

test("cost estimates follow Anthropic's list prices, and unknown models are priced high", () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000 };
  assert.equal(estimateUsd("claude-opus-5", usage), 5 + 2.5);
  assert.equal(estimateUsd("claude-haiku-4-5", usage), 1 + 0.5);
  assert.equal(estimateUsd("some-new-model", usage), estimateUsd("claude-opus-5", usage));
  assert.ok(Math.abs(estimateUsd("claude-opus-5", { cache_read_input_tokens: 1_000_000 }) - 0.5) < 1e-9);
});

test("limits come from settings, with safe defaults for missing or nonsense values", () => {
  assert.deepEqual(limitsFrom({}), { perHour: 20, perDay: 60, dailyUsd: 2 });
  assert.deepEqual(limitsFrom({ RATE_PER_HOUR: "5", DAILY_BUDGET_USD: "0.5", RATE_PER_DAY: "banana" }), { perHour: 5, perDay: 60, dailyUsd: 0.5 });
});

// These requests never reach the model: they're refused or fail validation first.
const chat = (env, { code, body = "{}" } = {}) =>
  worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.1", ...(code && { "x-access-code": code }) },
      body,
    }),
    env,
  );

test("with an access code set, the chat refuses requests without it", async () => {
  const env = { ANTHROPIC_API_KEY: "test", ACCESS_CODE: "maple" };
  const res = await chat(env);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).needsCode, true);
  assert.equal((await chat(env, { code: "wrong" })).status, 401);
  // The right code gets past the gate (and then fails on the empty question, as it should).
  const ok = await chat(env, { code: "maple", body: "not json" });
  assert.equal(ok.status, 400);
});

test("the server applies the hourly limit before anything reaches the model", async () => {
  const env = { ANTHROPIC_API_KEY: "test", DB: openLocalD1(), RATE_PER_HOUR: "1" };
  assert.equal((await chat(env, { body: JSON.stringify({ messages: [] }) })).status, 400); // counted, then rejected as empty
  const second = await chat(env, { body: JSON.stringify({ messages: [] }) });
  assert.equal(second.status, 429);
});
