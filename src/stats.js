// Usage counts for the friends test and the pitch: how many questions a day, how many people,
// how many came back, and which lookups answered. Rory's call (2026-10-27).
//
// Privacy: only numbers per day, never what anyone asked. A row is (day, what, count), e.g.
// ("2026-10-27", "tool get_menu", 4). Nothing per visitor is stored here: "visitors" counts
// first questions of the day using the anonymous daily code in limits.js, and "returning" is
// a yes/no the page sends (it remembers on the device whether it has asked before on an
// earlier day; no date or identifier is sent). Counts are kept, since they say nothing about anyone.
import { campusDate } from "./campus-time.js";

const SCHEMA = "CREATE TABLE IF NOT EXISTS stats (day TEXT NOT NULL, what TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, what))";

const ready = new WeakSet();
async function ensureTable(db) {
  if (ready.has(db)) return;
  await db.prepare(SCHEMA).run();
  ready.add(db);
}

// Tool names come from the server's own list, but are cut to size anyway: nothing free-form goes in.
const key = (what) => String(what).replace(/[^a-z0-9_ -]/gi, "").slice(0, 40);

export async function countUsage(db, whats, now = new Date()) {
  if (!whats.length) return;
  // A count that fails to save never stops an answer.
  try {
    await ensureTable(db);
    const day = campusDate(now);
    const bump = "INSERT INTO stats (day, what, n) VALUES (?, ?, 1) ON CONFLICT (day, what) DO UPDATE SET n = n + 1";
    await db.batch(whats.map((w) => db.prepare(bump).bind(day, key(w))));
  } catch (err) {
    console.error(`usage count failed: ${err?.name}: ${err?.message}`);
  }
}

// What one question adds. `firstToday` is from admit(); `returning` is the page's yes/no.
export function questionCounts({ firstToday, returning, followUp }) {
  const whats = ["questions"];
  if (firstToday) whats.push("visitors", ...(returning === true ? ["returning"] : []));
  if (followUp) whats.push("follow-ups");
  return whats;
}

// What one answer adds: answered, plus each kind of lookup used (once per answer). An answer
// that shows no card at all ("no source") had nothing sourced to show: the sign of a gap in
// what the app covers. Greetings, off-topic questions and refusals land there too.
export function answerCounts(tools = [], cards = []) {
  const used = [...new Set(tools)];
  return [
    "answered",
    ...(used.length ? used.map((t) => `tool ${t}`) : ["no lookup"]),
    ...(cards.length ? [] : ["no source"]),
  ];
}
