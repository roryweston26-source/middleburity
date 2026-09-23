// Rebuilds src/data/intercity.js: trains and intercity buses out of Vermont, from the operators'
// own published timetables (GTFS). Run by npm run build:transit, after the local buses.
// - Amtrak's national feed, cut to the four routes that serve Vermont or connect from it:
//   the Ethan Allen Express (stops in Middlebury), the Vermonter, the Adirondack (to Montreal)
//   and the Lake Shore Limited (Albany to Boston). Amtrak says it has no restrictions on using
//   its feed when the use sends riders to Amtrak.
// - Vermont Translines, the intercity bus along US-7 (Burlington, Middlebury, Rutland, Albany).
// Amtrak reissues its feed every week or so, and schedules change with the seasons, so
// check:feeds flags this file once it's a month old.
// Greyhound, Megabus and Dartmouth Coach aren't here: their schedules have no published open
// license, so the app points to them through Tri-Valley's Regional Connections page instead.
import { writeFile } from "node:fs/promises";
import { isoDate, loadGtfs } from "./gtfs.js";

const OUT = new URL("../src/data/intercity.js", import.meta.url);
const FILES = ["feed_info.txt", "agency.txt", "routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar.txt", "calendar_dates.txt"];

const FEEDS = [
  {
    id: "amtrak",
    name: "Amtrak",
    url: "https://content.amtrak.com/content/gtfs/GTFS.zip",
    site: "https://www.amtrak.com/",
    keep: (r) => r.agency_id === "51" && ["Ethan Allen Express", "Vermonter", "Adirondack", "Lake Shore Limited"].includes(r.route_long_name),
    // The feed's name for New York Penn is "Ny Moynihan Train Hall At Penn Station".
    rename: { NYP: "New York Moynihan Train Hall at Penn Station" },
  },
  {
    id: "vtt",
    name: "Vermont Translines",
    url: "https://data.trilliumtransit.com/gtfs/vttranslines-vt-us/vttranslines-vt-us.zip",
    site: "https://www.vttranslines.com/",
    keep: () => true,
    rename: {},
  },
];

const NEAR_M = 3000; // a stop named after a town brings in unnamed stops this close (Storrs Ave in Middlebury)
const WALK_M = 800; // stops this close are a walkable change between trips

const meters = (a, b) => {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  return Math.hypot(x, (b.lat - a.lat) * r) * 6371000;
};
const minutes = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const out = { builtOn: new Date().toISOString().slice(0, 10), feeds: {}, routes: {}, stops: {}, services: {}, trips: [] };

for (const feed of FEEDS) {
  const g = await loadGtfs(feed.url, FILES);
  const routes = g.routes.filter(feed.keep);
  if (!routes.length) throw new Error(`${feed.name}: none of the expected routes are in the feed any more. Nothing was written.`);
  const routeIds = new Set(routes.map((r) => r.route_id));
  for (const r of routes) {
    out.routes[`${feed.id}:${r.route_id}`] = { name: r.route_long_name || `Route ${r.route_short_name}`, operator: feed.name, url: r.route_url || feed.site };
  }

  const trips = new Map();
  for (const t of g.trips) {
    if (routeIds.has(t.route_id)) trips.set(t.trip_id, { route: `${feed.id}:${t.route_id}`, service: `${feed.id}:${t.service_id}`, headsign: t.trip_headsign, times: [] });
  }
  const used = new Set();
  for (const st of g.stop_times) {
    const trip = trips.get(st.trip_id);
    const arr = st.arrival_time || st.departure_time;
    const dep = st.departure_time || st.arrival_time;
    if (!trip || !arr) continue;
    // Flags: 1 = can't board here, 2 = can't get off here.
    const flags = (st.pickup_type === "1" ? 1 : 0) | (st.drop_off_type === "1" ? 2 : 0);
    if (flags === 3) continue;
    trip.times.push([Number(st.stop_sequence), `${feed.id}:${st.stop_id}`, minutes(arr), minutes(dep), flags]);
    used.add(`${feed.id}:${st.stop_id}`);
  }
  for (const t of trips.values()) {
    if (!t.times.length) continue;
    t.times.sort((a, b) => a[0] - b[0]);
    out.trips.push({ ...t, times: t.times.map(([, ...rest]) => rest) });
  }

  for (const s of g.stops) {
    const id = `${feed.id}:${s.stop_id}`;
    if (!used.has(id)) continue;
    out.stops[id] = { name: feed.rename[s.stop_id] ?? s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon), operator: feed.name, ...(s.stop_url && { url: s.stop_url }) };
  }

  const services = new Set([...trips.values()].map((t) => t.service));
  for (const c of g.calendar) {
    const id = `${feed.id}:${c.service_id}`;
    if (services.has(id)) out.services[id] = { days: DAYS.map((d) => c[d] === "1"), start: isoDate(c.start_date), end: isoDate(c.end_date), added: [], removed: [] };
  }
  for (const d of g.calendar_dates) {
    const id = `${feed.id}:${d.service_id}`;
    if (!services.has(id)) continue;
    out.services[id] ??= { days: DAYS.map(() => false), start: "9999-99-99", end: "0000-00-00", added: [], removed: [] };
    (d.exception_type === "1" ? out.services[id].added : out.services[id].removed).push(isoDate(d.date));
  }

  const info = g.feed_info[0] ?? {};
  out.feeds[feed.id] = { name: feed.name, site: feed.site, version: info.feed_version || null, published: info.feed_start_date ? isoDate(info.feed_start_date) : null };
}

// Which stops count as "near" each other (for place names) and as a walkable change.
const ids = Object.keys(out.stops);
out.near = {};
out.walk = {};
for (const a of ids) {
  for (const b of ids) {
    if (a === b) continue;
    const d = meters(out.stops[a], out.stops[b]);
    if (d <= NEAR_M) (out.near[a] ??= []).push(b);
    if (d <= WALK_M) (out.walk[a] ??= []).push([b, Math.ceil(d / 80)]); // about 80 m a minute, walking
  }
}

await writeFile(
  OUT,
  "// Generated by scripts/build-intercity.js from Amtrak's and Vermont Translines' GTFS feeds. Don't edit by hand; rerun it.\n" +
    `export const INTERCITY = ${JSON.stringify(out)};\n`,
);
console.log(
  `Wrote ${Object.keys(out.routes).length} routes, ${out.trips.length} trips, ${ids.length} stops ` +
    `(${Object.values(out.feeds).map((f) => `${f.name} ${f.version ?? ""}`.trim()).join(", ")}).`,
);
