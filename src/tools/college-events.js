// Middlebury's official events calendar (middlebury.edu/events): lectures, performances,
// symposia, colloquia and office events that student groups don't post on Presence. The
// listing is 20 events a page from a start date (?start-date=YYYY-MM-DD&page=N), each an
// <article> with its start time, title, sponsors, description and place. robots.txt allows
// /events with a one-second crawl delay, so pages are fetched a second apart and cached.
// Events sponsored by student organizations are left out: Presence (get_events) has those.
import { addDays, campusDate } from "../campus-time.js";
import { ToolInputError } from "./errors.js";
import { toPlainText } from "./events.js";
import { USER_AGENT } from "../user-agent.js";

const SITE = "https://www.middlebury.edu";
export const LISTING = `${SITE}/events/`;
const CACHE_MS = 2 * 60 * 60 * 1000;
const MAX_PAGES = 6; // 120 events, about four days of the fall calendar
const DELAY_MS = 1000;
export const SOURCE_LABEL = "Middlebury events calendar (middlebury.edu)";

const cache = new Map();
export function clearCollegeEventsCache() {
  cache.clear();
}

const text = (html) => toPlainText(html ?? "", 400);

export function parseListing(html) {
  const events = [];
  for (const [, body] of html.matchAll(/<article\b[^>]*aria-labelledby="midd-event-[^"]*"[^>]*>([\s\S]*?)<\/article>/g)) {
    const start = body.match(/<time datetime="([^"]+)"/)?.[1];
    const link = body.match(/<h3[\s\S]*?<a href="([^"]+)"[\s\S]*?<span>([\s\S]*?)<\/span>/);
    if (!start || !link) continue;
    const sponsors = [...body.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => text(m[1])).filter(Boolean);
    events.push({
      name: text(link[2]),
      url: new URL(link[1], SITE).href,
      start: new Date(start).toISOString(),
      org: sponsors.join(", ") || null,
      studentOrg: /midd-student-org/.test(body),
      description: text(body.match(/<div class="[^"]*typography[^"]*">([\s\S]*?)<\/div>/)?.[1]) || null,
      location: text(body.match(/<p class="[^"]*font-medium[^"]*">([\s\S]*?)<\/p>/)?.[1]) || null,
      public: /Open to the Public/i.test(body),
    });
  }
  return events;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pages from `from` until they pass `to` (or run out), one second apart. Pages are cached by
// start date and only extended as far as a question needs, so "today" and "this weekend"
// share what's already fetched.
async function loadRange(from, to, fetchImpl, wait) {
  let entry = cache.get(from);
  if (!entry || Date.now() - entry.at >= CACHE_MS) {
    entry = { at: Date.now(), events: [], pages: 0, done: false };
    cache.set(from, entry);
  }
  const reaches = () => entry.done || (entry.events.length && campusDate(new Date(entry.events.at(-1).start)) > to);
  while (!reaches() && entry.pages < MAX_PAGES) {
    if (entry.pages) await wait(DELAY_MS);
    const res = await fetchImpl(`${LISTING}?start-date=${from}&page=${entry.pages}`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`events calendar returned ${res.status}`);
    const found = parseListing(await res.text());
    entry.events.push(...found);
    entry.pages++;
    if (found.length < 20) entry.done = true;
  }
  return entry;
}

export async function getCollegeEvents({ from, to, keyword, publicOnly = false, limit = 8, now = new Date() } = {}, fetchImpl = fetch, wait = sleep) {
  const start = from ?? campusDate(now);
  const end = to ?? start;
  const { at, events } = await loadRange(start, end, fetchImpl, wait);
  const words = (keyword ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = events.filter((e) => {
    const day = campusDate(new Date(e.start));
    // Student-group events are on Presence, and varsity games come from get_games.
    if (day < start || day > end || e.studentOrg || /\bteam\b/i.test(e.org ?? "")) return false;
    if (start === campusDate(now) && new Date(e.start) < new Date(now.getTime() - 60 * 60 * 1000)) return false; // started over an hour ago
    if (publicOnly && !e.public) return false;
    const hay = [e.name, e.org, e.description, e.location].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return { checkedAt: new Date(at).toISOString(), from: start, to: end, total: hits.length, events: hits.slice(0, limit) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const collegeEventsTool = {
  definition: {
    name: "get_college_events",
    description:
      "Middlebury's official events calendar: lectures, talks, performances and concerts, symposia, colloquia, admissions and office events, with time, place, sponsor and whether it's open to the public. " +
      "Student-group events aren't here (get_events has those), so for \"what's happening\" questions check both. Times are start times; the calendar lists no end time. It covers at most three days: for a specific named event further ahead, search get_events by name (many arts and office events are on Presence too).",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD in Vermont time. Omit for today." },
        to: { type: "string", description: "Last day, YYYY-MM-DD, at most three days after from. Omit for a single day." },
        keyword: { type: "string", description: 'Words to match in the title, sponsor, description or place, e.g. "concert", "lecture", "Mahaney".' },
        public_only: { type: "boolean", description: "Only events marked open to the public." },
        limit: { type: "integer", description: "How many events, 1-12. Default 8." },
      },
      additionalProperties: false,
    },
  },
  async run(input) {
    for (const k of ["from", "to"]) if (input[k] !== undefined && !DATE.test(input[k])) throw new ToolInputError(`${k} must be YYYY-MM-DD`);
    if (input.from && input.to && (input.to < input.from || input.to > addDays(input.from, 3))) throw new ToolInputError("to must be within three days after from");
    if (input.keyword !== undefined && typeof input.keyword !== "string") throw new ToolInputError("keyword must be a string");
    const limit = Math.min(Math.max(Number(input.limit) || 8, 1), 12);
    const r = await getCollegeEvents({ from: input.from, to: input.to, keyword: input.keyword?.trim() || undefined, publicOnly: input.public_only === true, limit });
    const at = (e) => new Date(e.start).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return {
      content: JSON.stringify({
        source: SOURCE_LABEL,
        note: "Official college calendar; student-group events are on Presence (get_events). Times are Vermont time, start only.",
        days: r.from === r.to ? r.from : `${r.from} to ${r.to}`,
        matching: r.total,
        events: r.events.map((e) => ({ name: e.name, starts: at(e), where: e.location, sponsor: e.org, ...(e.public && { open_to_public: true }), about: e.description })),
      }),
      card: {
        type: "events",
        title: "College events",
        total: r.total,
        events: r.events,
        note: " From Middlebury's official calendar; start times only.",
        source: { label: SOURCE_LABEL, url: LISTING, checkedAt: r.checkedAt },
      },
    };
  },
};
