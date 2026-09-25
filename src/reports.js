// "Report this answer": the one thing the app keeps about a conversation, and only when the
// person taps it. Rory's call (2026-09-25), for the friends test: questions aren't logged, but
// a tester can choose to send one answer, with an optional note, so it can be fixed.
//
// Privacy: a report holds what the tester chose to send (the question, the answer, up to four
// earlier turns for context, their note) plus which lookups and model answered. No IP address,
// no visitor code, nothing that says who sent it. Reports are deleted after 60 days.
export const KEEP_DAYS = 60;
export const MAX_PER_DAY = 200; // for the whole app; a flood of reports stops here, not in the bill

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, at TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, context TEXT, note TEXT, tools TEXT, cards TEXT, model TEXT)";

export class ReportInputError extends Error {}

const text = (v, max, name, { required = false } = {}) => {
  if (v == null || v === "") {
    if (required) throw new ReportInputError(`A report needs the ${name}.`);
    return null;
  }
  if (typeof v !== "string") throw new ReportInputError(`The ${name} has to be text.`);
  return v.trim().slice(0, max) || null;
};
const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12).map((x) => x.slice(0, 40)) : []);

// Only what the page sends on purpose, cut to size; anything else in the body is ignored.
export function cleanReport(body) {
  if (!body || typeof body !== "object") throw new ReportInputError("Send the report as JSON.");
  const context = Array.isArray(body.context)
    ? body.context
        .slice(-4)
        .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
        .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))
    : [];
  return {
    question: text(body.question, 2000, "question", { required: true }),
    answer: text(body.answer, 6000, "answer", { required: true }),
    note: text(body.note, 1000, "note"),
    context: context.length ? JSON.stringify(context) : null,
    tools: names(body.tools).join(" > ") || null,
    cards: names(body.cards).join(", ") || null,
    model: text(body.model, 80, "model"),
  };
}

export async function saveReport(db, report, now = new Date()) {
  await db.prepare(SCHEMA).run();
  const day = now.toISOString().slice(0, 10);
  const today = await db.prepare("SELECT count(*) AS n FROM reports WHERE at >= ?").bind(day).first("n");
  if (today >= MAX_PER_DAY) return { ok: false };
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 864e5).toISOString();
  const r = report;
  await db.batch([
    db
      .prepare("INSERT INTO reports (at, question, answer, context, note, tools, cards, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now.toISOString(), r.question, r.answer, r.context, r.note, r.tools, r.cards, r.model),
    db.prepare("DELETE FROM reports WHERE at < ?").bind(cutoff),
  ]);
  return { ok: true };
}
