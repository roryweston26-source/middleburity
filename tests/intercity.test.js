import assert from "node:assert/strict";
import { test } from "node:test";
import { clock, findTrips, intercityTool, stopsFor } from "../src/tools/intercity.js";

// A small timetable in build-intercity.js's shape. Times are minutes after midnight;
// each stop is [stop, arrives, departs, flags].
const h = (hhmm) => hhmm.split(":").reduce((a, b) => Number(a) * 60 + Number(b));
const daily = { days: [true, true, true, true, true, true, true], start: "2026-09-01", end: "2027-09-01", added: [], removed: [] };
const data = {
  builtOn: "2026-09-23",
  feeds: { amtrak: { name: "Amtrak" }, vtt: { name: "Vermont Translines" } },
  routes: {
    ea: { name: "Ethan Allen Express", operator: "Amtrak", url: "https://example.org/ea" },
    ls: { name: "Lake Shore Limited", operator: "Amtrak", url: "https://example.org/ls" },
    bus: { name: "Route 7", operator: "Vermont Translines", url: "https://example.org/7" },
  },
  stops: {
    MBY: { name: "Middlebury", lat: 44.0174, lon: -73.1698 },
    STORRS: { name: "Storrs Ave SB at Franklin St", lat: 44.0101, lon: -73.1745 },
    FER: { name: "Ferrisburgh", lat: 44.18, lon: -73.25 },
    ALB: { name: "Albany-Rensselaer Amtrak Station", lat: 42.641, lon: -73.7411 },
    REN: { name: "AMTRAK Station Rensselaer", lat: 42.6409, lon: -73.7413 },
    NYP: { name: "New York Moynihan Train Hall at Penn Station", lat: 40.75, lon: -73.99 },
    BOS: { name: "Boston", lat: 42.35, lon: -71.05 },
  },
  near: { MBY: ["STORRS"], STORRS: ["MBY"], ALB: ["REN"], REN: ["ALB"] },
  walk: { ALB: [["REN", 1]], REN: [["ALB", 1]] },
  services: { daily },
  trips: [
    { route: "ea", service: "daily", headsign: "New York", times: [["FER", h("9:54"), h("9:54"), 0], ["MBY", h("10:11"), h("10:11"), 0], ["ALB", h("13:34"), h("13:49"), 0], ["NYP", h("16:27"), h("16:27"), 0]] },
    { route: "ea", service: "daily", headsign: "Burlington", times: [["MBY", h("20:26"), h("20:26"), 0], ["FER", h("20:45"), h("20:45"), 0]] },
    { route: "ls", service: "daily", headsign: "Boston", times: [["ALB", h("15:27"), h("15:27"), 0], ["BOS", h("20:24"), h("20:24"), 0]] },
    { route: "bus", service: "daily", headsign: "Albany", times: [["STORRS", h("14:37"), h("14:37"), 0], ["REN", h("18:05"), h("18:05"), 0]] },
  ],
};

test("a town name also finds nearby stops the feed names by street", () => {
  assert.deepEqual([...stopsFor(data, "Middlebury")].sort(), ["MBY", "STORRS"]);
  assert.ok(stopsFor(data, "NYC").has("NYP"));
});

test("a direct train comes back with its own times", () => {
  const r = findTrips(data, { from: "Middlebury", to: "NYC", date: "2026-09-25" });
  assert.deepEqual(r.trips.map((it) => it.map((l) => `${l.from}-${l.to} ${l.leaves}-${l.arrives}`)), [[`MBY-NYP ${h("10:11")}-${h("16:27")}`]]);
});

test("one change at the same station, with time to make it", () => {
  const r = findTrips(data, { from: "Middlebury", to: "Boston", date: "2026-09-25" });
  assert.equal(r.trips.length, 1);
  const [a, b] = r.trips[0];
  assert.equal(a.to, "ALB");
  assert.equal(b.from, "ALB");
  assert.equal(b.leaves - a.arrives, h("15:27") - h("13:34"));
});

test("no connection is offered that goes backwards through the start, or waits overnight", () => {
  // The evening train north to Ferrisburgh can't be turned into next morning's train south.
  const r = findTrips(data, { from: "Middlebury", to: "NYC", date: "2026-09-25", after: h("12:00") });
  assert.equal(r.trips.length, 0);
});

test("a bus and a train connect across a short walk between two operators' stops", () => {
  const busOnly = { ...data, trips: data.trips.filter((t) => t.route !== "ea") };
  busOnly.trips.push({ route: "ls", service: "daily", headsign: "Boston", times: [["ALB", h("19:00"), h("19:00"), 0], ["BOS", h("23:30"), h("23:30"), 0]] });
  const r = findTrips(busOnly, { from: "Middlebury", to: "Boston", date: "2026-09-25" });
  assert.deepEqual(r.trips[0].map((l) => `${l.from}-${l.to}`), ["STORRS-REN", "ALB-BOS"]);
});

test("times past midnight name the next day", () => {
  assert.equal(clock(h("16:27"), "2026-09-25"), "4:27pm");
  assert.equal(clock(24 * 60 + 27, "2026-09-25"), "12:27am Sat, Sep 26");
});

test("the tool finds the next day with trips when a day has none left, and says so", async () => {
  const late = new Date("2026-09-26T02:00:00Z"); // Fri 10pm in Vermont
  const out = JSON.parse((await intercityTool.run({ from: "Middlebury", to: "NYC" }, {}, late, data)).content);
  assert.match(out.note_date, /Nothing left on Fri, Sep 25/);
  assert.equal(out.trips.length, 1);
  assert.match(out.trips[0].legs[0].leaves, /10:11am/);
});

test("unknown places are said plainly, with what isn't covered", async () => {
  const out = JSON.parse((await intercityTool.run({ from: "Middlebury", to: "Portland" }, {}, new Date("2026-09-25T12:00:00Z"), data)).content);
  assert.match(out.result, /No Amtrak or Vermont Translines stop matches "Portland".*Greyhound/);
});
