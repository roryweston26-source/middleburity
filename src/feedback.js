// Feedback on an answer (👍 / 👎 under each one): the one thing the app keeps about a
// conversation, and only when the person taps a thumb and presses Send. Rory's call
// (2026-09-25), for the friends test: questions aren't logged, but a tester can choose to send
// one answer with a rating and an optional note.
//
// Privacy: feedback holds what the tester chose to send (the question, the answer, up to four
// earlier turns for context, the rating, their note) plus which lookups and model answered.
// No IP address, no visitor code, nothing that says who sent it. Deleted after 60 days.
export const KEEP_DAYS = 60;
export const MAX_PER_DAY = 200; // for the whole app; a flood of feedback stops here

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, at TEXT NOT NULL, rating TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, context TEXT, note TEXT, tools TEXT, cards TEXT, model TEXT)";

export class FeedbackInputError extends Error {}

const text = (v, max, name, { required = false } = {}) => {
  if (v == null || v === "") {
    if (required) throw new FeedbackInputError(`Feedback needs the ${name}.`);
    return null;
  }
  if (typeof v !== "string") throw new FeedbackInputError(`The ${name} has to be text.`);
  return v.trim().slice(0, max) || null;
};
const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 12).map((x) => x.slice(0, 40)) : []);

// Only what the page sends on purpose, cut to size; anything else in the body is ignored.
export function cleanFeedback(body) {
  if (!body || typeof body !== "object") throw new FeedbackInputError("Send the feedback as JSON.");
  if (body.rating !== "up" && body.rating !== "down") throw new FeedbackInputError("Feedback needs a thumbs up or down.");
  const context = Array.isArray(body.context)
    ? body.context
        .slice(-4)
        .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
        .map((t) => ({ role: t.role, content: t.content.slice(0, 2000) }))
    : [];
  return {
    rating: body.rating,
    question: text(body.question, 2000, "question", { required: true }),
    answer: text(body.answer, 6000, "answer", { required: true }),
    note: text(body.note, 1000, "note"),
    context: context.length ? JSON.stringify(context) : null,
    tools: names(body.tools).join(" > ") || null,
    cards: names(body.cards).join(", ") || null,
    model: text(body.model, 80, "model"),
  };
}

export async function saveFeedback(db, f, now = new Date()) {
  await db.prepare(SCHEMA).run();
  const day = now.toISOString().slice(0, 10);
  const today = await db.prepare("SELECT count(*) AS n FROM feedback WHERE at >= ?").bind(day).first("n");
  if (today >= MAX_PER_DAY) return { ok: false };
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 864e5).toISOString();
  await db.batch([
    db
      .prepare("INSERT INTO feedback (at, rating, question, answer, context, note, tools, cards, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now.toISOString(), f.rating, f.question, f.answer, f.context, f.note, f.tools, f.cards, f.model),
    db.prepare("DELETE FROM feedback WHERE at < ?").bind(cutoff),
  ]);
  return { ok: true };
}
