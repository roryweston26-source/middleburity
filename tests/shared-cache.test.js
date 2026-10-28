import assert from "node:assert/strict";
import { test } from "node:test";
import { openLocalD1 } from "../src/db/node-d1.js";
import { createCache, decode, encode, useCacheStore } from "../src/shared-cache.js";

const HOUR = 60 * 60 * 1000;

test("Maps, Sets and Dates survive the trip through D1's text", () => {
  const value = { days: new Map([["2026-10-28", new Set(["7:30am-midnight"])]]), at: new Date("2026-10-28T12:00:00Z"), list: [1, "two", null] };
  assert.deepEqual(decode(encode(value)), value);
});

test("a fresh copy in D1 is used after memory is gone, with the time it was first read", async () => {
  useCacheStore(openLocalD1());
  const cache = createCache("t1");
  let loads = 0;
  const first = await cache.get("k", HOUR, async () => ++loads);
  cache.clear(); // a new Worker: memory empty, D1 still there
  const second = await cache.get("k", HOUR, async () => ++loads);
  assert.equal(loads, 1);
  assert.equal(second.value, 1);
  assert.equal(second.at, first.at);
  useCacheStore(null);
});

test("an expired row is fetched again", async () => {
  const db = openLocalD1();
  useCacheStore(db);
  const cache = createCache("t2");
  await cache.write("k", { at: Date.now() - 2 * HOUR, value: "old" });
  cache.clear();
  const { value } = await cache.get("k", HOUR, async () => "new");
  assert.equal(value, "new");
  assert.equal(await db.prepare("SELECT body FROM fetch_cache WHERE key = 't2|k'").first("body"), '"new"');
  useCacheStore(null);
});

test("two lookups asking at once fetch once", async () => {
  useCacheStore(openLocalD1());
  const cache = createCache("t3");
  let loads = 0;
  const load = async () => {
    loads++;
    await new Promise((r) => setTimeout(r, 20));
    return "x";
  };
  await Promise.all([cache.get("k", HOUR, load), cache.get("k", HOUR, load)]);
  assert.equal(loads, 1);
  useCacheStore(null);
});

test("a broken store or an oversized value never fails the lookup", async () => {
  const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1 down"); } }) }), batch: async () => { throw new Error("D1 down"); } };
  useCacheStore(broken);
  const cache = createCache("t4");
  assert.equal((await cache.get("k", HOUR, async () => "fine")).value, "fine");

  const db = openLocalD1();
  useCacheStore(db);
  await cache.get("big", HOUR, async () => "x".repeat(2_000_000));
  await cache.get("small", HOUR, async () => "y");
  assert.deepEqual((await db.prepare("SELECT key FROM fetch_cache").all()).results.map((r) => r.key), ["t4|small"]);
  useCacheStore(null);
});

test("without a store it's a memory cache, as before", async () => {
  useCacheStore(null);
  const cache = createCache("t5");
  let loads = 0;
  await cache.get("k", HOUR, async () => ++loads);
  await cache.get("k", HOUR, async () => ++loads);
  cache.clear();
  await cache.get("k", HOUR, async () => ++loads);
  assert.equal(loads, 2);
});
