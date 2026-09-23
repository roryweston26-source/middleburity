import assert from "node:assert/strict";
import { test } from "node:test";
import { clearFlightsCache, flightsTool, normalizeFlight, searchBoard } from "../src/tools/flights.js";
import { outsideSite } from "../src/tools/pages.js";
import { stubFetch } from "./helpers.js";

const board = {
  count: 3,
  flights: [
    { type: "D", date: "2026-09-23", airline: "United Airlines", airlineCode: "UA", flight: "4575", city: "Newark", scheduled: "6:50 PM", actual: "6:50 PM", status: "On Time", gate: "8" },
    { type: "D", date: "2026-09-24", airline: "American Airlines", airlineCode: "AA", flight: "6196", city: "Chicago", scheduled: "7:10 AM", actual: "7:40 AM", status: "Late", gate: "1" },
    { type: "A", date: "2026-09-23", airline: "Delta Air Lines", airlineCode: "DL", flight: "4944", city: "New York-JFK", scheduled: "1:48 PM", actual: "1:48 PM", status: "OnTime", gate: "14" },
  ],
};
const flights = board.flights.map(normalizeFlight);

test("flights keep the board's own times; a changed time shows as the new one", () => {
  assert.equal(flights[0].actual, null);
  assert.equal(flights[1].actual, "7:40 AM");
  assert.equal(flights[2].status, "On Time");
});

test("the board lists the cities it serves and what matches a search", () => {
  const r = searchBoard(flights, { direction: "departure", city: "los angeles" });
  assert.equal(r.total, 0);
  assert.deepEqual(r.cities, ["Chicago", "Newark"]);
  assert.deepEqual(r.covers, { from: "2026-09-23", to: "2026-09-24" });
  assert.equal(searchBoard(flights, { direction: "arrival", city: "new york" }).total, 1);
});

test("the tool reads the airport's board with a User-Agent and makes a card", async (t) => {
  clearFlightsCache();
  const requested = stubFetch(t, { "btv.aero": { body: board } });
  const out = await flightsTool.run({ city: "chicago" });
  const j = JSON.parse(out.content);
  assert.equal(j.flights[0].now_expected, "7:40 AM");
  assert.deepEqual(j.departure_cities_on_board, ["Chicago", "Newark"]);
  assert.equal(out.card.type, "flights");
  assert.ok(requested.inits[0].headers["user-agent"]);
});

test("pages from outside Middlebury are labelled with their site", () => {
  assert.equal(outsideSite("https://www.trivalleytransit.org/regional-connections/"), "trivalleytransit.org");
  assert.equal(outsideSite("https://handbook.middlebury.edu/pages/x/"), null);
  assert.equal(outsideSite("https://www.middlebury.edu/dining-services"), null);
});
