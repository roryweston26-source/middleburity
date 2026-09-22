import assert from "node:assert/strict";
import { test } from "node:test";
import { busTool, clock, findBuses, runsOn } from "../src/tools/bus.js";

// A tiny timetable in the shape build-transit.js writes.
const data = {
  validFrom: "2026-09-04",
  validTo: "2026-11-01",
  routes: {
    link: { name: "Burlington Link", url: "https://example.org/link" },
    msb: { name: "MSB - Hannaford", url: "https://example.org/msb" },
    snow: { name: "Snow Bowl Shuttle Bus", url: "https://example.org/snow" },
  },
  stops: {
    acad: { name: "Academy Street" },
    adk: { name: "College, Adirondack Circle/Rte 125" },
    han: { name: "Hannaford/Centre Plaza" },
    btv: { name: "Downtown Transit Center" },
    pine: { name: "College Street at Pine Street" },
  },
  services: {
    wk: { days: [true, true, true, true, true, false, false], start: "2026-09-04", end: "2026-11-01", added: [], removed: ["2026-10-12"] },
  },
  trips: [
    { route: "link", service: "wk", headsign: "Burlington", times: [["acad", "07:15"], ["pine", "08:30"], ["btv", "08:45"]] },
    { route: "link", service: "wk", headsign: "Middlebury", times: [["btv", "16:00"], ["acad", "17:15"]] },
    { route: "msb", service: "wk", headsign: "Middlebury", times: [["acad", "08:00"], ["adk", "08:04"], ["han", "08:14"]] },
  ],
};

test("service days follow the calendar and its removed dates", () => {
  assert.equal(runsOn(data.services.wk, "2026-09-22"), true);
  assert.equal(runsOn(data.services.wk, "2026-09-26"), false); // Saturday
  assert.equal(runsOn(data.services.wk, "2026-10-12"), false); // removed
});

test("with no stop named, buses board on campus or at Academy Street, never Burlington's College Street", () => {
  const r = findBuses({ date: "2026-09-22", after: "07:00" }, data);
  assert.deepEqual(r.departures.map((d) => `${d.time} ${d.stop}`), ["07:15 Academy Street", "08:00 Academy Street", "08:04 College, Adirondack Circle/Rte 125"]);
  assert.equal(r.departures[0].arrive.stop, "Downtown Transit Center");
});

test("a 'to' stop gives the arrival there, and the return trip needs its own 'from'", () => {
  const r = findBuses({ to: "hannaford", date: "2026-09-22", after: "07:00" }, data);
  assert.deepEqual(r.departures.map((d) => [d.stop, d.arrive.time]), [["Academy Street", "08:14"], ["College, Adirondack Circle/Rte 125", "08:14"]]);
  const back = findBuses({ from: "downtown transit center", date: "2026-09-22" }, data);
  assert.equal(back.departures[0].arrive.stop, "Academy Street");
});

test("after the last bus, the next day with service is offered", () => {
  const r = findBuses({ route: "link", date: "2026-09-25", after: "18:00" }, data);
  assert.equal(r.departures.length, 0);
  assert.equal(r.nextDate, "2026-09-28"); // the weekend has none
});

test("a route with no trips, and a date outside the timetable, are said plainly", () => {
  assert.equal(findBuses({ route: "snow bowl", date: "2026-09-22" }, data).unscheduled, true);
  assert.equal(findBuses({ date: "2026-12-01" }, data).covered, false);
});

test("times read as a clock, including trips past midnight", () => {
  assert.equal(clock("07:05"), "7:05am");
  assert.equal(clock("13:30"), "1:30pm");
  assert.equal(clock("24:10"), "12:10am (after midnight)");
});

test("the tool uses the saved timetable and refuses dates it doesn't cover", async () => {
  const out = JSON.parse((await busTool.run({ date: "2030-01-01" })).content);
  assert.match(out.result, /only covers/);
});
