// Opening hours that Middlebury keeps in live calendars: the library's (LibCal) and the
// athletic facilities' (public Google Calendars that the athletics site embeds). Dining
// hall, café and Mail Center hours are posted as page text instead, so they come from
// search_pages.
import { addDays, campusDate } from "../campus-time.js";
import { ToolInputError } from "./errors.js";
import { USER_AGENT } from "../user-agent.js";
import { toPlainText } from "./events.js";

const CACHE_MS = 3 * 60 * 60 * 1000; // hours change a few times a term, around breaks
const LIBCAL = "https://middlebury.libcal.com/widget/hours/grid?iid=3442&format=json&weeks=2&systemTime=0";
const LIBCAL_PAGE = "https://middlebury.libcal.com/hours/";
const GCAL = (id) => `https://calendar.google.com/calendar/ical/${id}%40group.calendar.google.com/public/basic.ics`;
const ATHLETICS_HOURS = "https://athletics.middlebury.edu/sports/2020/6/4/facilities-facilities-hours";

export const PLACES = {
  library: { name: "Davis Family Library", libcal: 4403 },
  "crossroads-cafe": { name: "Crossroads Café", libcal: 23916 },
  "research-help": { name: "Library research help (online)", libcal: 7344 },
  "special-collections": { name: "Special Collections", libcal: 10819 },
  "athletic-complex": { name: "Athletic facilities (general open hours)", gcal: "nrusevg9me9pg139f9n0hoo934" },
  "fitness-center": { name: "Fitness Center", gcal: "t0e014c4u6vpndfjcgqqe25ct8" },
  pool: { name: "Natatorium (pool)", gcal: "0b3h20dfo8ep5ojt765one44qo" },
};

const cache = new Map(); // source url -> { at, data }
export function clearHoursCache() {
  cache.clear();
}

async function cached(url, parse, now = new Date()) {
  const hit = cache.get(url);
  // Re-read at least daily too, since the calendar cutoff below moves with the date.
  if (hit && Date.now() - hit.at < CACHE_MS && hit.day === campusDate(now)) return hit;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`hours source returned ${res.status}`);
  const entry = { at: Date.now(), day: campusDate(now), data: parse(await res.text()) };
  cache.set(url, entry);
  return entry;
}

// ---------- Calendar files ----------

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

const vermontTime = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

// A calendar time as Vermont wall-clock time: { date: "2026-09-22", time: "09:00" | null }.
// Times with a TZID are taken as written (every one in these calendars is America/New_York);
// UTC times are converted; dates alone are all-day.
export function localTime(params, value) {
  const m = value?.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{2}(Z?))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, z] = m;
  if (!h || /VALUE=DATE(?!-)/.test(params ?? "")) return { date: `${y}-${mo}-${d}`, time: null };
  if (!z) return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
  const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  return { date: campusDate(utc), time: vermontTime(utc) };
}
const key = (t) => `${t.date}T${t.time ?? ""}`;

// Whether an entry, judged from its raw text, can still matter on or after `since`
// (YYYYMMDD). These calendars go back to 2013, and skipping the old entries before
// parsing them is what keeps a request inside the Workers CPU limit.
function stillMatters(body, since) {
  const date = (name) => body.match(new RegExp(`^${name}[^:\\r\\n]*:(\\d{8})`, "m"))?.[1];
  const rid = date("RECURRENCE-ID");
  if (rid) return rid >= since || date("DTSTART") >= since;
  const rule = body.match(/^RRULE:(.*)$/m)?.[1];
  if (!rule) return (date("DTEND") ?? date("DTSTART") ?? "") >= since;
  const until = rule.match(/UNTIL=(\d{8})/)?.[1];
  if (until) return until >= since;
  const count = rule.match(/COUNT=(\d+)/)?.[1];
  if (!count) return true;
  // A weekly rule with a count ends within count weeks (times its interval) of its start.
  const start = date("DTSTART") ?? "";
  const weeks = Number(count) * Number(rule.match(/INTERVAL=(\d+)/)?.[1] ?? 1);
  return addDays(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`, weeks * 7).replace(/-/g, "") >= since;
}

export function parseCalendar(text, since = "00000000") {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const masters = [];
  const overrides = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.slice(0, block.indexOf("END:VEVENT"));
    if (!stillMatters(body, since)) continue;
    const lines = {};
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
      if (m) (lines[m[1]] ??= []).push({ params: m[2], value: m[3].trim() });
    }
    const one = (name) => lines[name]?.[0];
    const start = one("DTSTART") && localTime(one("DTSTART").params, one("DTSTART").value);
    if (!start) continue;
    const end = one("DTEND") ? localTime(one("DTEND").params, one("DTEND").value) : null;
    const event = {
      uid: one("UID")?.value,
      start,
      end,
      summary: (one("SUMMARY")?.value ?? "").replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ").trim(),
      cancelled: one("STATUS")?.value === "CANCELLED",
    };
    const rid = one("RECURRENCE-ID");
    if (rid) {
      overrides.push({ ...event, replaces: key(localTime(rid.params, rid.value)) });
      continue;
    }
    const rrule = one("RRULE")?.value;
    if (rrule) event.rule = Object.fromEntries(rrule.split(";").map((p) => p.split("=")));
    event.exdates = new Set(
      (lines.EXDATE ?? []).flatMap(({ params, value }) => value.split(",").map((v) => key(localTime(params, v)))),
    );
    masters.push(event);
  }
  return { masters, overrides };
}

// Occurrences of a weekly rule from `from` to `to`, as { date, time } starts.
function weekly(event, from, to) {
  const { rule, start } = event;
  if (rule.FREQ !== "WEEKLY") return [];
  let until = null;
  if (rule.UNTIL) {
    const u = localTime(/T/.test(rule.UNTIL) ? "" : "VALUE=DATE", rule.UNTIL);
    until = u.time ? key(u) : `${u.date}T99`;
  }
  if (until && until < `${from}T`) return [];
  const days = rule.BYDAY ? rule.BYDAY.split(",").map((d) => WEEKDAYS.indexOf(d.slice(-2))) : [weekday(start.date)];
  const interval = Number(rule.INTERVAL ?? 1);
  const wkst = WEEKDAYS.indexOf(rule.WKST ?? "MO");
  const weekStart = (date) => addDays(date, -((weekday(date) - wkst + 7) % 7));
  const firstWeek = weekStart(start.date);
  const out = [];
  let count = 0;
  // COUNT has to be counted from the first occurrence; otherwise start at the window.
  let date = rule.COUNT || start.date > from ? start.date : from;
  for (; date <= to; date = addDays(date, 1)) {
    if (!days.includes(weekday(date))) continue;
    if ((daysBetween(firstWeek, weekStart(date)) / 7) % interval !== 0) continue;
    const t = { date, time: start.time };
    if (until && key(t) > until) break;
    if (rule.COUNT && ++count > Number(rule.COUNT)) break;
    if (date >= from) out.push(t);
  }
  return out;
}

const shift = (event, t) => {
  const length = event.end ? daysBetween(event.start.date, event.end.date) : 0;
  return { date: t.date, start: t.time, end: event.end?.time ?? null, lastDate: addDays(t.date, length), summary: event.summary };
};

// Every entry in the calendar that falls on each date from `from` to `to`.
export function entriesBetween(calendar, from, to) {
  const replaced = new Set(calendar.overrides.map((o) => `${o.uid}|${o.replaces}`));
  const found = [];
  for (const event of calendar.masters) {
    const starts = event.rule ? weekly(event, addDays(from, -7), to) : [event.start];
    for (const t of starts) {
      if (event.exdates.has(key(t)) || replaced.has(`${event.uid}|${key(t)}`)) continue;
      found.push(shift(event, t));
    }
  }
  for (const o of calendar.overrides) if (!o.cancelled) found.push(shift(o, o.start));

  const byDate = new Map();
  for (let d = from; d <= to; d = addDays(d, 1)) byDate.set(d, []);
  for (const e of found) {
    // All-day entries run up to (not including) their end date; timed ones sit on their start date.
    const last = e.start === null ? addDays(e.lastDate, e.lastDate > e.date ? -1 : 0) : e.date;
    for (let d = e.date < from ? from : e.date; d <= last && d <= to; d = addDays(d, 1)) byDate.get(d)?.push(e);
  }
  for (const [date, list] of byDate) {
    // Calendars sometimes carry two overlapping rules that say the same thing; say it once.
    const seen = new Set();
    const unique = list.filter((e) => {
      const k = `${e.start}|${e.end}|${e.summary}`;
      return !seen.has(k) && seen.add(k);
    });
    byDate.set(date, unique.sort((a, b) => ((a.start ?? "") < (b.start ?? "") ? -1 : 1)));
  }
  return byDate;
}

const clock = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

// What an entry says about the hours. These calendars mostly write the hours as the entry's
// title ("6am-10pm", "CLOSED"); some titles are just "Open Hours", and then the entry's own
// times are the hours.
export function describe(entry) {
  const title = entry.summary || "Open";
  if (/\d/.test(title) || /closed/i.test(title) || entry.start === null) return title;
  return `${clock(entry.start)}-${entry.end ? clock(entry.end) : "?"} (${title})`;
}

// ---------- Sources ----------

function parseLibcal(text) {
  const json = JSON.parse(text);
  const byLid = new Map();
  for (const loc of json.locations ?? []) {
    const days = new Map();
    for (const week of loc.weeks ?? []) {
      for (const day of Object.values(week)) {
        const t = day.times ?? {};
        const hours =
          t.status === "closed" ? "Closed"
          : t.status === "not-set" ? null
          : t.status === "24hours" ? "Open 24 hours"
          : t.hours?.length ? t.hours.map((h) => `${h.from}-${h.to}`).join(", ")
          : toPlainText(day.rendered ?? "", 160) || null;
        days.set(day.date, hours);
      }
    }
    byLid.set(loc.lid, days);
  }
  return byLid;
}

export async function getHours(placeId, from, to, now = new Date()) {
  const place = PLACES[placeId];
  if (place.libcal) {
    const { at, data } = await cached(LIBCAL, parseLibcal, now);
    const days = data.get(place.libcal) ?? new Map();
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, hours: days.has(d) ? (days.get(d) ? [days.get(d)] : []) : null });
    return { checkedAt: new Date(at).toISOString(), url: LIBCAL_PAGE, label: "Middlebury Libraries hours (LibCal)", days: out };
  }
  // Entries that ended over a week ago are skipped at parse time (see stillMatters).
  const since = addDays(campusDate(now), -7).replace(/-/g, "");
  const { at, data } = await cached(GCAL(place.gcal), (text) => parseCalendar(text, since), now);
  const byDate = entriesBetween(data, from, to);
  return {
    checkedAt: new Date(at).toISOString(),
    url: ATHLETICS_HOURS,
    label: "Middlebury Athletics facility hours",
    days: [...byDate].map(([date, entries]) => ({ date, hours: entries.map(describe) })),
  };
}

const dayLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

export const hoursTool = {
  definition: {
    name: "get_hours",
    description:
      "Posted opening hours, day by day, from the calendars Middlebury keeps them in: the library, Crossroads Café and library research help (LibCal, about two weeks ahead), " +
      "and the athletic facilities, fitness center and pool (the athletics department's calendars). " +
      "A day with no entry means nothing is posted for it, not that the place is closed. " +
      "Other hours (dining halls, the Grille and other retail spots, the Mail Center, offices) are written on Middlebury's pages: use search_pages for those. " +
      "Kenyon Arena, Pepin Gym, Nelson Rec Center and climbing wall hours aren't in a calendar this can read (the climbing wall's has had no new entries since 2023): search Middlebury's pages, or say you couldn't find them.",
    input_schema: {
      type: "object",
      properties: {
        place: { type: "string", enum: Object.keys(PLACES), description: "Which place. athletic-complex is the building's general open hours." },
        date: { type: "string", description: "First day, YYYY-MM-DD, Vermont time. Omit for today." },
        days: { type: "integer", description: "How many days from the first, 1-7. Default 1." },
      },
      required: ["place"],
      additionalProperties: false,
    },
  },
  async run(input, env, now = new Date()) {
    if (!PLACES[input.place]) throw new ToolInputError(`place must be one of: ${Object.keys(PLACES).join(", ")}`);
    if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ToolInputError("date must be YYYY-MM-DD");
    const from = input.date ?? campusDate(now);
    if (from < addDays(campusDate(now), -6)) throw new ToolInputError("only current and upcoming hours are available");
    const to = addDays(from, Math.min(7, Math.max(1, Number(input.days) || 1)) - 1);
    const result = await getHours(input.place, from, to, now);
    const name = PLACES[input.place].name;
    return {
      content: JSON.stringify({
        source: result.label,
        place: name,
        note: "Hours as posted. A day marked 'nothing posted' has no entry in the calendar; don't guess it.",
        days: result.days.map((d) => ({
          date: `${dayLabel(d.date)} (${d.date})`,
          hours: d.hours === null ? "nothing posted (beyond what the calendar covers)" : d.hours.length ? d.hours : "nothing posted",
        })),
      }),
      card: {
        type: "hours",
        place: name,
        days: result.days.map((d) => ({ date: d.date, hours: d.hours ?? [] })),
        source: { label: result.label, url: result.url, checkedAt: result.checkedAt },
      },
    };
  },
};
