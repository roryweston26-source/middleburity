// Bus times from Tri-Valley Transit's published timetable (src/data/transit.js, built by
// npm run build:transit). Tri-Valley, formerly ACTR, runs the Middlebury Shuttle, the
// Burlington Link and Addison County's other routes. The timetable is issued for a couple
// of months at a time, and the tool refuses dates outside it rather than guess.
import { addDays, campusDate } from "../campus-time.js";
import { TRANSIT } from "../data/transit.js";
import { ToolInputError } from "./errors.js";

export const SOURCE_LABEL = "Tri-Valley Transit timetable";
const SOURCE_URL = "https://www.trivalleytransit.org/";

// The feed names the in-town shuttle's loops "MSB - College", "MSB - Hannaford"...
export const routeName = (name) => name.replace(/^MSB - (.+)$/, "Middlebury Shuttle ($1 loop)");

const words = (s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const matches = (text, keyword) => {
  const have = words(text);
  return words(keyword).every((w) => have.some((h) => h.startsWith(w)));
};

// With no stop named, riders are on campus or downtown: campus stops are named "College, ..."
// or "College/..." ("College Street at Pine Street" is in Burlington), and Academy Street is
// the downtown hub most routes start from.
const isHome = (stopName) => /^College[,/]/.test(stopName) || stopName === "Academy Street";

export function runsOn(service, date) {
  if (!service) return false;
  if (service.removed.includes(date)) return false;
  if (service.added.includes(date)) return true;
  const day = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return service.days[day] && service.start <= date && date <= service.end;
}

// "14:05" -> "2:05pm"; GTFS times past midnight run over 24:00.
export const clock = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h % 24 < 12 ? "am" : "pm"}${h >= 24 ? " (after midnight)" : ""}`;
};

// Departures on one date, soonest first.
export function departures(data, { route, from, to, date, after = "00:00" }) {
  const stopName = (id) => data.stops[id]?.name ?? "";
  const routeText = (id) => `${data.routes[id].name} ${routeName(data.routes[id].name)}`;
  const out = [];
  for (const trip of data.trips) {
    if (route && !(matches(routeText(trip.route), route) || matches(trip.headsign, route))) continue;
    if (!runsOn(data.services[trip.service], date)) continue;
    const t = trip.times;
    // Where the rider gets on: the stop they named, else campus or Academy Street.
    const starts = t.map((s, i) => i).filter((i) => (from ? matches(stopName(t[i][0]), from) : isHome(stopName(t[i][0]))));
    for (const i of starts) {
      if (t[i][1] < after || i === t.length - 1) continue;
      const j = to ? t.findIndex((s, k) => k > i && matches(stopName(s[0]), to)) : t.length - 1;
      if (j < 0) continue;
      out.push({
        route: routeName(data.routes[trip.route].name),
        url: data.routes[trip.route].url,
        headsign: trip.headsign || null,
        stop: stopName(t[i][0]),
        time: t[i][1],
        arrive: { stop: stopName(t[j][0]), time: t[j][1] },
      });
    }
  }
  const seen = new Set();
  return out
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
    .filter((d) => {
      const k = `${d.route}|${d.stop}|${d.time}|${d.arrive.stop}`;
      return !seen.has(k) && seen.add(k);
    });
}

export function findBuses({ route, from, to, date, after, limit = 6 }, data = TRANSIT) {
  const covered = data.validFrom <= date && date <= data.validTo;
  const base = { validFrom: data.validFrom, validTo: data.validTo, date };
  if (!covered) return { ...base, covered: false, departures: [] };
  const routes = Object.entries(data.routes).filter(([, r]) => !route || matches(`${r.name} ${routeName(r.name)}`, route));
  const scheduled = routes.filter(([id]) => data.trips.some((t) => t.route === id));
  const found = departures(data, { route, from, to, date, after }).slice(0, limit);
  if (found.length) return { ...base, covered: true, departures: found };
  base.noneAllDay = after > "00:00" ? !departures(data, { route, from, to, date }).length : true;
  // Nothing left on that date: find the next day in the timetable that has some.
  for (let d = addDays(date, 1); d <= data.validTo && d <= addDays(date, 7); d = addDays(d, 1)) {
    const next = departures(data, { route, from, to, date: d }).slice(0, limit);
    if (next.length) return { ...base, covered: true, departures: [], nextDate: d, next };
  }
  return { ...base, covered: true, departures: [], unscheduled: routes.length > 0 && !scheduled.length, routeFound: routes.length > 0 };
}

const dayLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

function forModel(input, r) {
  const list = (ds) => ds.map((d) => ({ route: d.route, ...(d.headsign && { toward: d.headsign }), leaves: `${clock(d.time)} from ${d.stop}`, arrives: `${clock(d.arrive.time)} at ${d.arrive.stop}` }));
  const base = { source: `${SOURCE_LABEL} (valid ${r.validFrom} to ${r.validTo})`, date: `${dayLabel(r.date)} (${r.date})` };
  if (!r.covered) return { ...base, result: `The saved timetable only covers ${r.validFrom} to ${r.validTo}, so there are no times for this date. Tri-Valley Transit's site has the current schedule.` };
  if (r.departures.length) return { ...base, note: "Published timetable times, not live tracking.", departures: list(r.departures) };
  if (r.next) {
    const none = r.noneAllDay ? "No departures matching this run at all on that date." : "No more departures matching this on that date.";
    return { ...base, result: none, next_day_with_service: dayLabel(r.nextDate), departures: list(r.next) };
  }
  if (!r.routeFound) return { ...base, result: `No Tri-Valley Transit route in Addison County matches "${input.route}".`, routes: Object.values(TRANSIT.routes).map((x) => routeName(x.name)) };
  if (r.unscheduled) return { ...base, result: `That route has no trips at all in the timetable running through ${r.validTo}.` };
  return { ...base, result: "No departures matching this in the next week of the timetable. The stop names may not match; stops are named like 'College, Adirondack Circle/Rte 125' or 'Academy Street'." };
}

export const busTool = {
  definition: {
    name: "get_bus",
    description:
      "Tri-Valley Transit (formerly ACTR) timetable: the Middlebury Shuttle, Burlington Link, 116 Commuter, TriTown (Bristol, Vergennes), Rutland Connector and Snow Bowl shuttle. " +
      "Next departures from campus stops and Academy Street unless another stop is named; for a trip back to Middlebury, name the stop they leave from. " +
      "Timetable times, not live tracking. Never estimate a bus time the tool didn't return. " +
      "SGA break buses: search_pages.",
    input_schema: {
      type: "object",
      properties: {
        route: { type: "string", description: "Route words, e.g. \"shuttle\", \"burlington link\", \"rutland\", \"snow bowl\". Omit for every route." },
        from: { type: "string", description: "Words from the boarding stop's name, e.g. \"academy street\", \"amtrak\". Omit for campus stops." },
        to: { type: "string", description: "Words from the stop the rider wants to reach, e.g. \"downtown transit center\", \"hannaford\"." },
        date: { type: "string", description: "YYYY-MM-DD, Vermont time. Omit for today." },
        after: { type: "string", description: "HH:MM (24-hour). Omit for now when the date is today." },
        limit: { type: "integer", description: "How many departures, 1-10. Default 6." },
      },
      additionalProperties: false,
    },
  },
  async run(input, env, now = new Date()) {
    for (const k of ["route", "from", "to"]) if (input[k] !== undefined && typeof input[k] !== "string") throw new ToolInputError(`${k} must be a string`);
    if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ToolInputError("date must be YYYY-MM-DD");
    if (input.after !== undefined && !/^\d{1,2}:\d{2}$/.test(input.after)) throw new ToolInputError("after must be HH:MM");
    const today = campusDate(now);
    const date = input.date ?? today;
    const nowTime = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    const after = input.after ? input.after.padStart(5, "0") : date === today ? nowTime : "00:00";
    const q = { route: input.route?.trim() || undefined, from: input.from?.trim() || undefined, to: input.to?.trim() || undefined };
    const result = findBuses({ ...q, date, after, limit: Math.min(10, Math.max(1, Number(input.limit) || 6)) });
    const shown = result.departures.length ? result.departures : (result.next ?? []);
    return {
      content: JSON.stringify(forModel(q, result)),
      card: {
        type: "bus",
        date: result.nextDate ?? date,
        covered: result.covered,
        departures: shown,
        source: { label: SOURCE_LABEL, url: SOURCE_URL, validTo: TRANSIT.validTo, builtOn: TRANSIT.builtOn },
      },
    };
  },
};
