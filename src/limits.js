// Spending protection: per-visitor limits on questions per hour and per day, plus a hard
// daily dollar cap for the whole app. The counts live in the same database as page search.
//
// Privacy: a visitor is an anonymous code, a hash of the date, a secret salt and their IP
// address. The IP itself is never stored, yesterday's code can't be linked to today's, and
// counts older than two days are deleted. Nothing about what anyone asked is kept.
import { campusDate } from "./campus-time.js";

export const DEFAULTS = { perHour: 20, perDay: 60, dailyUsd: 2 };

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS usage (period TEXT NOT NULL, visitor TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (period, visitor))",
  "CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL NOT NULL DEFAULT 0)",
];

const ready = new WeakSet();
async function ensureTables(db) {
  if (ready.has(db)) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  ready.add(db);
}

export function limitsFrom(env = {}) {
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return {
    perHour: num(env.RATE_PER_HOUR, DEFAULTS.perHour),
    perDay: num(env.RATE_PER_DAY, DEFAULTS.perDay),
    dailyUsd: num(env.DAILY_BUDGET_USD, DEFAULTS.dailyUsd),
  };
}

export async function visitorId(ip, day, salt) {
  const bytes = new TextEncoder().encode(`${day}|${salt}|${ip}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Periods are strings that sort by time: "2026-09-22" for a day, "2026-09-22T15" for an hour (UTC).
const periods = (now) => ({ day: campusDate(now), hour: now.toISOString().slice(0, 13) });

export async function spentToday(db, now = new Date()) {
  await ensureTables(db);
  return (await db.prepare("SELECT usd FROM spend WHERE day = ?").bind(periods(now).day).first("usd")) ?? 0;
}

// Decides whether a question may go to the model, and counts it if so.
export async function admit(db, { visitor, limits, now = new Date() }) {
  await ensureTables(db);
  const { day, hour } = periods(now);
  if ((await spentToday(db, now)) >= limits.dailyUsd) {
    return { ok: false, status: 503, error: "Middleburity has reached its spending limit for today. Try again tomorrow." };
  }
  const count = async (period) =>
    (await db.prepare("SELECT n FROM usage WHERE period = ? AND visitor = ?").bind(period, visitor).first("n")) ?? 0;
  const [thisHour, today] = [await count(`h ${hour}`), await count(`d ${day}`)];
  if (thisHour >= limits.perHour) {
    return { ok: false, status: 429, error: `That's ${limits.perHour} questions this hour, the most one person can ask. Try again in a bit.` };
  }
  if (today >= limits.perDay) {
    return { ok: false, status: 429, error: `That's ${limits.perDay} questions today, the most one person can ask. Try again tomorrow.` };
  }
  const bump = "INSERT INTO usage (period, visitor, n) VALUES (?, ?, 1) ON CONFLICT (period, visitor) DO UPDATE SET n = n + 1";
  const cutoff = `h ${new Date(now.getTime() - 2 * 864e5).toISOString().slice(0, 13)}`;
  await db.batch([
    db.prepare(bump).bind(`h ${hour}`, visitor),
    db.prepare(bump).bind(`d ${day}`, visitor),
    // Old hour counts are deleted as new ones come in; day counts go once their day is past.
    db.prepare("DELETE FROM usage WHERE (period LIKE 'h %' AND period < ?) OR (period LIKE 'd %' AND period < ?)").bind(cutoff, `d ${campusDate(new Date(now.getTime() - 2 * 864e5))}`),
  ]);
  return { ok: true, remainingToday: limits.perDay - today - 1 };
}

export async function recordSpend(db, usd, now = new Date()) {
  if (!(usd > 0)) return;
  await ensureTables(db);
  await db
    .prepare("INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd")
    .bind(periods(now).day, usd)
    .run();
}
