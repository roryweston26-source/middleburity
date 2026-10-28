// What the lookups fetched, kept in memory and in D1. A Worker's memory lasts only while that
// copy of it stays warm, and Cloudflare shuts an idle one down within minutes, so with a few
// testers nearly every question used to find the memory cache empty and refetch its sources
// (the events calendar alone takes 4-17 s from cold). D1 outlives that: the first question
// after a quiet spell reads what an earlier one fetched, if it's still fresh.
//
// Without a store (tests, check:feeds, test mode) it's the plain memory cache it replaced.

let store = null; // a D1 binding, or null
let ready = false;

// worker.js sets this per request. Test mode passes null, so planted test data never
// lands in a database another server reads.
export function useCacheStore(db) {
  if (db !== store) ready = false;
  store = db ?? null;
}

// D1 caps a row at 2 MB. The Presence events feed is the biggest at about 600 KB (2026-10-28).
const MAX_BYTES = 1_900_000;
const KEEP_MS = 2 * 24 * 60 * 60 * 1000; // longer than any cache time, so old rows can go
const SCHEMA = "CREATE TABLE IF NOT EXISTS fetch_cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)";

// JSON that keeps Maps, Sets and Dates (the hours calendars are Maps of Sets).
export function encode(value) {
  return JSON.stringify(value, function (key, v) {
    const raw = this[key];
    if (raw instanceof Map) return { __map__: [...raw] };
    if (raw instanceof Set) return { __set__: [...raw] };
    if (raw instanceof Date) return { __date__: raw.toISOString() };
    return v;
  });
}

export function decode(text) {
  return JSON.parse(text, (key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("__map__" in v) return new Map(v.__map__);
      if ("__set__" in v) return new Set(v.__set__);
      if ("__date__" in v) return new Date(v.__date__);
    }
    return v;
  });
}

// One cache per source. Entries are { at, value }; `at` is when the source was read, which
// is what the cards show as "checked".
export function createCache(name) {
  const memory = new Map();
  const pending = new Map(); // key -> promise, so two lookups in one round fetch once
  const id = (key) => `${name}|${key}`;

  async function read(key, maxAgeMs) {
    const hit = memory.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit;
    if (!store) return null;
    try {
      const row = await store.prepare("SELECT at, body FROM fetch_cache WHERE key = ?").bind(id(key)).first();
      if (!row || Date.now() - row.at >= maxAgeMs) return null;
      const entry = { at: row.at, value: decode(row.body) };
      memory.set(key, entry);
      return entry;
    } catch {
      return null; // no table yet, or D1 is unreachable: fetch the source instead
    }
  }

  async function write(key, entry) {
    memory.set(key, entry);
    if (!store) return;
    try {
      const body = encode(entry.value);
      if (new TextEncoder().encode(body).length > MAX_BYTES) return;
      const statements = [
        store.prepare("INSERT OR REPLACE INTO fetch_cache (key, at, body) VALUES (?, ?, ?)").bind(id(key), entry.at, body),
        store.prepare("DELETE FROM fetch_cache WHERE at < ?").bind(Date.now() - KEEP_MS),
      ];
      if (!ready) statements.unshift(store.prepare(SCHEMA));
      await store.batch(statements);
      ready = true;
    } catch (err) {
      // The answer doesn't wait on the cache: the memory copy still serves this Worker.
      console.error(`cache write failed: ${err?.name}: ${err?.message}`);
    }
  }

  // The fresh entry for `key`, or `load()`'s value, saved with the time it was read.
  async function get(key, maxAgeMs, load) {
    const hit = await read(key, maxAgeMs);
    if (hit) return hit;
    if (pending.has(key)) return pending.get(key);
    const promise = (async () => {
      const entry = { at: Date.now(), value: await load() };
      await write(key, entry);
      return entry;
    })();
    pending.set(key, promise);
    try {
      return await promise;
    } finally {
      pending.delete(key);
    }
  }

  return { get, read, write, clear: () => memory.clear() };
}
