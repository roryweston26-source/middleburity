// Trains and intercity buses between towns, from Amtrak's and Vermont Translines' published
// timetables (src/data/intercity.js, built by npm run build:transit). Finds direct trips and
// trips with one change (at the same station, or a short walk apart), and never suggests a
// connection the timetables don't show. Greyhound, Megabus and Dartmouth Coach aren't covered:
// their schedules have no open license, so the model points to them via search_pages.
import { addDays, campusDate } from "../campus-time.js";
import { INTERCITY } from "../data/intercity.js";
import { runsOn } from "./bus.js";
import { ToolInputError } from "./errors.js";

const MIN_CHANGE = 20; // minutes to change trains at the same station
const MAX_WAIT = 6 * 60; // longer than this between legs isn't offered as a connection
const DAY = 24 * 60;

// People say "NYC"; the feed says "New York".
const ALIASES = { nyc: "new york", manhattan: "new york", "penn station": "new york", btv: "burlington", montréal: "montreal" };

const words = (s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Stops whose names contain every word, plus unnamed stops near them ("Middlebury" also finds
// the Translines stop on Storrs Avenue).
export function stopsFor(data, place) {
  const wanted = words(ALIASES[place.trim().toLowerCase()] ?? place);
  if (!wanted.length) return new Set();
  const direct = Object.keys(data.stops).filter((id) => {
    const have = words(data.stops[id].name);
    return wanted.every((w) => have.some((h) => h.startsWith(w)));
  });
  return new Set([...direct, ...direct.flatMap((id) => data.near[id] ?? [])]);
}

// Every trip running on `date`, including the tail of yesterday's overnight trips, with its
// times moved so 0 is midnight at the start of `date`.
function tripsOn(data, date) {
  const out = [];
  for (const [d, shift] of [[addDays(date, -1), -DAY], [date, 0], [addDays(date, 1), DAY]]) {
    for (const trip of data.trips) if (runsOn(data.services[trip.service], d)) out.push({ trip, shift, date: d });
  }
  return out;
}

// Each stop on a trip is [stop, arrives, departs, flags], times in minutes after midnight.
const STOP = 0, ARR = 1, DEP = 2, FLAGS = 3;
const canBoard = (s) => !(s[FLAGS] & 1);
const canLeave = (s) => !(s[FLAGS] & 2);

export function findTrips(data, { from, to, date, after = 0, limit = 4 }) {
  const origins = stopsFor(data, from);
  const dests = stopsFor(data, to);
  if (!origins.size || !dests.size) return { origins: origins.size, dests: dests.size, trips: [] };
  const running = tripsOn(data, date);
  // Where each running trip can be boarded, by stop, so a change looks up its stop directly.
  const boardings = new Map();
  for (const run of running) {
    run.trip.times.forEach((s, m) => {
      if (canBoard(s)) (boardings.get(s[STOP]) ?? boardings.set(s[STOP], []).get(s[STOP])).push([run, m]);
    });
  }
  const found = [];
  const leg = ({ trip, shift, date: serviceDate }, i, j) => ({
    route: data.routes[trip.route],
    headsign: trip.headsign || null,
    from: trip.times[i][STOP],
    leaves: trip.times[i][DEP] + shift,
    to: trip.times[j][STOP],
    arrives: trip.times[j][ARR] + shift,
    serviceDate,
  });

  for (const run of running) {
    const t = run.trip.times;
    for (let i = 0; i < t.length; i++) {
      const leaves = t[i][DEP] + run.shift;
      if (!origins.has(t[i][STOP]) || !canBoard(t[i]) || leaves < after || leaves >= DAY) continue;
      const j = t.findIndex((s, x) => x > i && dests.has(s[STOP]) && canLeave(s) && !origins.has(s[STOP]));
      if (j > i) {
        found.push([leg(run, i, j)]);
        continue; // this trip goes there itself; changing off it won't be quicker
      }
      // One change: get off later on, then board another trip there (or a short walk away).
      for (let k = i + 1; k < t.length; k++) {
        if (!canLeave(t[k]) || origins.has(t[k][STOP])) continue;
        const arrives = t[k][ARR] + run.shift;
        for (const [changeStop, walkMins] of [[t[k][STOP], 0], ...(data.walk[t[k][STOP]] ?? [])]) {
          for (const [other, m] of boardings.get(changeStop) ?? []) {
            if (other.trip === run.trip) continue;
            const u = other.trip.times;
            const departs = u[m][DEP] + other.shift;
            if (departs < arrives + Math.max(MIN_CHANGE, walkMins + 10) || departs > arrives + MAX_WAIT) continue;
            const n = u.findIndex((s, x) => x > m && dests.has(s[STOP]) && canLeave(s));
            if (n < 0) continue;
            // A second trip that passes through the start could have been boarded there.
            if (u.slice(0, n).some((s) => origins.has(s[STOP]))) continue;
            found.push([leg(run, i, k), leg(other, m, n)]);
          }
        }
      }
    }
  }

  // Keep the sensible options: for each departure, the earliest arrival; and drop any trip that
  // leaves earlier but gets in no sooner than another (or later), preferring direct trips on ties.
  const arrive = (it) => it.at(-1).arrives;
  const depart = (it) => it[0].leaves;
  const slack = (it) => (it.length > 1 ? it[1].leaves - it[0].arrives : 0);
  // On equal times, a direct trip first, then the change with the most time to make it.
  found.sort((a, b) => arrive(a) - arrive(b) || a.length - b.length || depart(b) - depart(a) || slack(b) - slack(a));
  const kept = [];
  for (const it of found) {
    if (kept.some((k) => depart(k) >= depart(it) && arrive(k) <= arrive(it))) continue;
    kept.push(it);
  }
  kept.sort((a, b) => depart(a) - depart(b));
  return { origins: origins.size, dests: dests.size, trips: kept.slice(0, limit) };
}

export function clock(mins, date) {
  const day = Math.floor(mins / DAY);
  const m = ((mins % DAY) + DAY) % DAY;
  const h = Math.floor(m / 60);
  const text = `${h % 12 || 12}:${String(m % 60).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  if (!day) return text;
  const label = new Date(`${addDays(date, day)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return `${text} ${label}`;
}

const dayLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

const describe = (data, it, date) => ({
  ...(it.length > 1 && { change: `at ${data.stops[it[1].from].name}, ${Math.round(it[1].leaves - it[0].arrives)} minutes to change` }),
  legs: it.map((l) => ({
    service: `${l.route.operator} ${l.route.name}${l.headsign ? ` toward ${l.headsign}` : ""}`,
    leaves: `${clock(l.leaves, date)} from ${data.stops[l.from].name}`,
    arrives: `${clock(l.arrives, date)} at ${data.stops[l.to].name}`,
  })),
});

export const intercityTool = {
  definition: {
    name: "get_trains_and_buses",
    description:
      "Amtrak and Vermont Translines timetables: direct and one-change trips between towns on a given day, times Eastern. " +
      "Covers the Ethan Allen Express (stops in Middlebury; Burlington–Rutland–Albany–New York), Vermonter, Adirondack (to Montreal) and Lake Shore Limited (Albany–Boston), and Translines' US-7 bus (Burlington and its airport, Middlebury, Rutland, Bennington, Albany and its airport). " +
      "No Greyhound, Megabus or Dartmouth Coach: search_pages (Tri-Valley's Regional Connections page) for who runs those. " +
      "Never offer a trip or connection this tool didn't return; tickets and current schedules are on the operator's site.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Town or station, e.g. \"Middlebury\", \"Burlington\", \"Albany\"." },
        to: { type: "string", description: "Town or station, e.g. \"New York\", \"Boston\", \"Montreal\"." },
        date: { type: "string", description: "Travel day, YYYY-MM-DD. Omit for today." },
        after: { type: "string", description: "Earliest departure, HH:MM (24-hour). Omit for now when the date is today." },
        limit: { type: "integer", description: "How many trips, 1-6. Default 4." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  async run(input, env, now = new Date(), data = INTERCITY) {
    for (const k of ["from", "to"]) if (typeof input[k] !== "string" || !input[k].trim()) throw new ToolInputError(`${k} must be a town or station name`);
    if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ToolInputError("date must be YYYY-MM-DD");
    if (input.after !== undefined && !/^\d{1,2}:\d{2}$/.test(input.after)) throw new ToolInputError("after must be HH:MM");
    const today = campusDate(now);
    const date = input.date ?? today;
    if (date < today) throw new ToolInputError("only today and later");
    const nowMins = (() => {
      const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now).split(":").map(Number);
      return h * 60 + m;
    })();
    const after = input.after ? input.after.split(":").reduce((h, m) => Number(h) * 60 + Number(m)) : date === today ? nowMins : 0;
    const limit = Math.min(6, Math.max(1, Number(input.limit) || 4));
    const q = { from: input.from.trim(), to: input.to.trim() };

    let result = findTrips(data, { ...q, date, after, limit });
    let shownDate = date;
    // Nothing left that day: the next day in the coming week that has some.
    if (!result.trips.length && result.origins && result.dests) {
      for (let d = addDays(date, 1); d <= addDays(date, 7); d = addDays(d, 1)) {
        const next = findTrips(data, { ...q, date: d, limit });
        if (next.trips.length) {
          result = next;
          shownDate = d;
          break;
        }
      }
    }
    const sources = Object.values(data.feeds).map((f) => f.name).join(" and ");
    const base = {
      source: `${sources} timetables, as published ${data.builtOn}`,
      date: `${dayLabel(shownDate)} (${shownDate})`,
      // In testing, answers about Boston and Montreal stopped at the train and missed the buses.
      other_operators:
        "Greyhound, Megabus and Dartmouth Coach aren't in these timetables. Before answering, search_pages \"Regional Connections Greyhound Megabus\": Tri-Valley Transit's page says which of them run from where (no times). Don't add options no source gives.",
    };
    let content;
    if (!result.origins) content = { ...base, result: `No Amtrak or Vermont Translines stop matches "${q.from}".` };
    else if (!result.dests) content = { ...base, result: `No Amtrak or Vermont Translines stop matches "${q.to}". Greyhound, Megabus and Dartmouth Coach aren't covered.` };
    else if (!result.trips.length) content = { ...base, result: "No direct or one-change trip in these timetables in the next week. Other operators may run it; search Middlebury's pages (Tri-Valley's Regional Connections page) for who does." };
    else {
      content = {
        ...base,
        ...(shownDate !== date && { note_date: `Nothing left on ${dayLabel(date)}; these are the next day with trips.` }),
        note: "Scheduled times from the published timetables. Schedules change: check the operator's site before booking.",
        trips: result.trips.map((it) => describe(data, it, shownDate)),
      };
    }
    return {
      content: JSON.stringify(content),
      card: {
        type: "trips",
        date: shownDate,
        from: q.from,
        to: q.to,
        trips: result.trips.map((it) =>
          it.map((l) => ({
            operator: l.route.operator,
            route: l.route.name,
            url: l.route.url,
            from: data.stops[l.from].name,
            leaves: clock(l.leaves, shownDate),
            to: data.stops[l.to].name,
            arrives: clock(l.arrives, shownDate),
          })),
        ),
        source: { label: `${sources} timetables`, published: data.builtOn },
      },
    };
  },
};
