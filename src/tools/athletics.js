// Varsity schedules and results from Middlebury Athletics' public calendar feed (iCalendar).
// The feed asks to be re-read every 2 hours (X-PUBLISHED-TTL) and the site asks crawlers to
// wait 30 seconds between requests, so it's fetched at most once per 2 hours, never per question.
import { campusDate } from "../campus-time.js";
import { USER_AGENT } from "../user-agent.js";
import { ToolInputError } from "./errors.js";

const FEED = "https://athletics.middlebury.edu/calendar.ashx/calendar.ics";
const CACHE_MS = 2 * 60 * 60 * 1000;
export const SOURCE_LABEL = "Middlebury Athletics schedule";
const SOURCE_URL = "https://athletics.middlebury.edu/calendar";

// Sports in the feed as of 2026-09-21. Only used to tell the model what it can ask for.
const SPORTS_HINT =
  "Field Hockey, Football, Men's/Women's Soccer, Women's Volleyball, Men's/Women's Cross Country, Men's/Women's Golf, " +
  "Men's/Women's Tennis, Men's/Women's Ice Hockey, Men's/Women's Basketball, Men's/Women's Squash, " +
  "Men's/Women's Swimming and Diving, Men's/Women's Track and Field, Alpine Skiing, Nordic Skiing";

let cache = null;
export function clearAthleticsCache() {
  cache = null;
}

function unescapeText(value) {
  return value.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

// "20260926T150000Z" -> "2026-09-26T15:00:00Z"; a date-only "20261002" -> "2026-10-02"
function toStamp(value) {
  const m = value?.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  return h ? `${y}-${mo}-${d}T${h}:${mi}:${s}${z || ""}` : `${y}-${mo}-${d}`;
}

export function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const games = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const field = (name) => {
      const m = block.match(new RegExp(`^${name}((?:;[^:\\r\\n]*)?):(.*)$`, "m"));
      return m ? { params: m[1], value: m[2].trim() } : null;
    };
    const summary = unescapeText(field("SUMMARY")?.value ?? "").replace(/^\[[A-Z]\]\s*/, "");
    const m = summary.match(/^Middlebury College (.+?) (?:vs|at) (.+)$/);
    if (!m) continue;
    const [, sport, rest] = m;
    const neutral = rest.match(/^(.*?) - Game Played at (.+)$/);
    const location = unescapeText(field("LOCATION")?.value ?? "");
    const home = /^Middlebury, VT\b/.test(location) && !neutral;
    const start = field("DTSTART");
    const lines = unescapeText(field("DESCRIPTION")?.value ?? "")
      .split("\n")
      .map((l) => l.trim());
    const score = lines.find((l, i) => i > 0 && /^[WLT] \d/.test(l));
    games.push({
      sport,
      opponent: (neutral ? neutral[1] : rest).trim(),
      home,
      venue: home ? location.replace(/^Middlebury, VT,?\s*/, "") || null : null,
      place: home ? "Middlebury, VT" : neutral ? `${neutral[2]} (${location})` : location || null,
      start: toStamp(start?.value),
      allDay: /VALUE=DATE/.test(start?.params ?? ""),
      result: score ?? (lines.some((l) => /No Team Scoring/i.test(l)) ? "no team score" : null),
      url: unescapeText(field("URL")?.value ?? "").replace(/&amp;/g, "&") || SOURCE_URL,
    });
  }
  return games.sort((a, b) => (a.start < b.start ? -1 : 1));
}

async function loadGames() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const res = await fetch(FEED, { headers: { accept: "text/calendar", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`athletics feed returned ${res.status}`);
  cache = { at: Date.now(), games: parseIcs(await res.text()) };
  return cache;
}

// The Vermont date a game falls on.
export function gameDate(game) {
  return game.allDay ? game.start : campusDate(new Date(game.start));
}

const words = (s) =>
  s
    .toLowerCase()
    .replace(/'s\b|’s\b/g, "")
    .replace(/\bwomens\b/g, "women")
    .replace(/\bmens\b/g, "men")
    .split(/[^a-z]+/)
    .filter(Boolean);

// "soccer" matches both soccer teams; "women's soccer" only one. Words must match exactly,
// so "men" never matches "women".
export function matchesSport(sport, query) {
  const have = new Set(words(sport));
  return words(query).every((w) => have.has(w));
}

export async function getGames({ sport, date, direction = "upcoming", homeOnly = false, limit = 5 } = {}, now = new Date()) {
  const { at, games: all } = await loadGames();
  let games = all;
  if (sport) {
    games = games.filter((g) => matchesSport(g.sport, sport));
    if (!games.length) throw new ToolInputError(`no sport matches "${sport}". Sports: ${SPORTS_HINT}`);
  }
  if (homeOnly) games = games.filter((g) => g.home);
  const today = campusDate(now);
  if (date) {
    games = games.filter((g) => gameDate(g) === date);
  } else if (direction === "recent") {
    games = games.filter((g) => g.result || gameDate(g) < today).reverse();
  } else {
    // Keep games that started in the last 3 hours: they may still be on.
    const cutoff = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    games = games.filter((g) => (g.allDay ? g.start >= today : g.start >= cutoff));
  }
  return { checkedAt: new Date(at).toISOString(), games: games.slice(0, limit) };
}

function when(game) {
  const opts = { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" };
  if (game.allDay) return `${new Date(`${game.start}T12:00:00Z`).toLocaleDateString("en-US", opts)} (time not posted)`;
  return new Date(game.start).toLocaleString("en-US", { ...opts, hour: "numeric", minute: "2-digit" });
}

function forModel(result) {
  return JSON.stringify({
    source: SOURCE_LABEL,
    note: "Times are Vermont time.",
    games: result.games.map((g) => ({
      sport: g.sport,
      opponent: g.opponent,
      when: when(g),
      date: gameDate(g),
      where: g.home ? `home, ${g.venue ?? "Middlebury"}` : `away, ${g.place ?? "location not posted"}`,
      ...(g.result && { result: g.result }),
    })),
  });
}

function validate(input) {
  const out = {};
  if (input.sport !== undefined) {
    if (typeof input.sport !== "string" || !input.sport.trim()) throw new ToolInputError("sport must be a non-empty string");
    out.sport = input.sport;
  }
  if (input.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ToolInputError("date must be YYYY-MM-DD");
    out.date = input.date;
  }
  if (input.direction !== undefined) {
    if (!["upcoming", "recent"].includes(input.direction)) throw new ToolInputError("direction must be upcoming or recent");
    out.direction = input.direction;
  }
  if (input.home_only !== undefined) out.homeOnly = Boolean(input.home_only);
  if (input.limit !== undefined) out.limit = Math.min(10, Math.max(1, Number(input.limit) || 5));
  return out;
}

export function gamesCard(result, title) {
  return { type: "games", title, games: result.games, source: { label: SOURCE_LABEL, url: SOURCE_URL, checkedAt: result.checkedAt } };
}

// Home screen card.
export async function nextHomeGames(now = new Date()) {
  return gamesCard(await getGames({ homeOnly: true, limit: 3 }, now), "Next home games");
}

export const athleticsTool = {
  definition: {
    name: "get_games",
    description:
      "Look up Middlebury varsity games from Middlebury Athletics' official calendar: upcoming schedules, recent results, or a given day. " +
      `Sports in the feed: ${SPORTS_HINT}. ` +
      "Home games include the venue (e.g. Peter Kohn Field); use get_directions if someone wants to get there. " +
      "Some meets have no posted time; say so rather than guessing one.",
    input_schema: {
      type: "object",
      properties: {
        sport: { type: "string", description: 'e.g. "field hockey", "women\'s soccer", "hockey". Omit for all sports.' },
        date: { type: "string", description: "A single day, YYYY-MM-DD in Vermont time. Omit to use direction." },
        direction: { type: "string", enum: ["upcoming", "recent"], description: "upcoming (default) or recent results." },
        home_only: { type: "boolean", description: "Only games at Middlebury." },
        limit: { type: "integer", description: "How many games, 1-10. Default 5." },
      },
      additionalProperties: false,
    },
  },
  async run(input) {
    const options = validate(input);
    const result = await getGames(options);
    const title = options.direction === "recent" ? "Recent results" : options.date ? "Games" : "Upcoming games";
    return { content: forModel(result), card: gamesCard(result, title) };
  },
};
