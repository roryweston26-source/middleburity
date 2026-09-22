// Rebuilds src/data/transit.js from Tri-Valley Transit's published timetable (GTFS): npm run build:transit
// Tri-Valley Transit (formerly ACTR) runs the Middlebury Shuttle, the Burlington Link and the
// other Addison County buses. Its feed is issued for a couple of months at a time (feed_end_date),
// so rerun this whenever check:feeds says the saved timetable is close to running out.
// The app never downloads the feed at runtime: unzipping and parsing it would blow the Workers
// free plan's 10 ms CPU limit, so only the Addison County routes are kept, in a small file.
import { writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { USER_AGENT } from "../src/user-agent.js";

const FEED = "https://data.trilliumtransit.com/gtfs/trivalleytransit-vt-us/trivalleytransit-vt-us.zip";
const OUT = new URL("../src/data/transit.js", import.meta.url);

// Reads the files out of a zip archive (stored or deflated entries, which is all GTFS uses).
function unzip(buf, wanted) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted.includes(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
  }
  return files;
}

// CSV with quoted fields (the feed's trip messages contain commas).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  const keys = head.map((h) => h.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const isoDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

const res = await fetch(FEED, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60000) });
if (!res.ok) throw new Error(`transit feed returned ${res.status}`);
const files = unzip(Buffer.from(await res.arrayBuffer()), [
  "feed_info.txt", "routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar.txt", "calendar_dates.txt",
]);
const csv = (name) => (files[name] ? parseCsv(files[name]) : []);

// Addison County's routes are the ones Tri-Valley files under /addison_routes/.
const routes = {};
for (const r of csv("routes.txt")) {
  if (!/\/addison_routes\//.test(r.route_url)) continue;
  routes[r.route_id] = { name: r.route_long_name || r.route_short_name, url: r.route_url };
}
if (Object.keys(routes).length < 5) throw new Error("fewer Addison County routes than expected; the feed may have changed. Nothing was written.");

const trips = new Map();
for (const t of csv("trips.txt")) {
  if (routes[t.route_id]) trips.set(t.trip_id, { route: t.route_id, service: t.service_id, headsign: t.trip_headsign, direction: t.direction_id, times: [] });
}

// Only stops with a scheduled time are kept. Stops the feed leaves untimed are passed on the
// way, and guessing their times is exactly what the app shouldn't do.
const usedStops = new Set();
for (const st of csv("stop_times.txt")) {
  const trip = trips.get(st.trip_id);
  const time = st.departure_time || st.arrival_time;
  if (!trip || !time) continue;
  if (st.pickup_type === "1" && st.drop_off_type === "1") continue;
  trip.times.push([Number(st.stop_sequence), st.stop_id, time.slice(0, 5).padStart(5, "0")]);
  usedStops.add(st.stop_id);
}

const stops = {};
for (const s of csv("stops.txt")) {
  if (usedStops.has(s.stop_id)) stops[s.stop_id] = { name: s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon) };
}

const usedServices = new Set([...trips.values()].map((t) => t.service));
const services = {};
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
for (const c of csv("calendar.txt")) {
  if (!usedServices.has(c.service_id)) continue;
  services[c.service_id] = { days: DAYS.map((d) => c[d] === "1"), start: isoDate(c.start_date), end: isoDate(c.end_date), added: [], removed: [] };
}
for (const d of csv("calendar_dates.txt")) {
  const s = services[d.service_id];
  if (s) (d.exception_type === "1" ? s.added : s.removed).push(isoDate(d.date));
}

const info = csv("feed_info.txt")[0] ?? {};
const out = {
  builtOn: new Date().toISOString().slice(0, 10),
  validFrom: info.feed_start_date ? isoDate(info.feed_start_date) : null,
  validTo: info.feed_end_date ? isoDate(info.feed_end_date) : null,
  routes,
  stops,
  services,
  trips: [...trips.values()]
    .filter((t) => t.times.length)
    .map((t) => ({ ...t, times: t.times.sort((a, b) => a[0] - b[0]).map(([, stop, time]) => [stop, time]) })),
};

await writeFile(
  OUT,
  "// Generated by scripts/build-transit.js from Tri-Valley Transit's GTFS feed. Don't edit by hand; rerun the script.\n" +
    `export const TRANSIT = ${JSON.stringify(out)};\n`,
);
console.log(
  `Wrote ${Object.keys(routes).length} routes, ${out.trips.length} trips, ${Object.keys(stops).length} stops. ` +
    `Timetable valid ${out.validFrom} to ${out.validTo}.`,
);
