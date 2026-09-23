import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnowbowlMonth } from "../src/tools/hours.js";
import { clearWeatherCache, summarizePeriod, weatherTool } from "../src/tools/weather.js";
import { stubFetch } from "./helpers.js";

const point = { properties: { forecast: "https://api.weather.gov/gridpoints/BTV/93,35/forecast", forecastHourly: "https://api.weather.gov/gridpoints/BTV/93,35/forecast/hourly" } };
const forecast = {
  properties: {
    updateTime: "2026-09-23T18:18:44+00:00",
    periods: [
      { name: "Tonight", startTime: "2026-09-23T18:00:00-04:00", temperature: 38, temperatureUnit: "F", probabilityOfPrecipitation: { value: 0 }, windSpeed: "1 to 5 mph", windDirection: "E", shortForecast: "Mostly Clear", detailedForecast: "Mostly clear, with a low around 38." },
      { name: "Thursday", startTime: "2026-09-24T06:00:00-04:00", temperature: 67, temperatureUnit: "F", probabilityOfPrecipitation: { value: null }, windSpeed: "1 to 9 mph", windDirection: "N", shortForecast: "Patchy Frost then Sunny", detailedForecast: "Patchy frost between 7am and 8am." },
    ],
  },
};
const alerts = {
  features: [
    { properties: { event: "Frost Advisory", headline: "Frost Advisory until September 24 at 9:00AM EDT", severity: "Minor", onset: "2026-09-24T02:00:00-04:00", ends: "2026-09-24T09:00:00-04:00", instruction: "Take steps now to protect tender plants from the cold." } },
  ],
};

test("forecast periods keep the Weather Service's own words; hourly ones get a time for a name", () => {
  const p = summarizePeriod(forecast.properties.periods[0]);
  assert.equal(p.summary, "Mostly Clear");
  assert.equal(p.chance_of_precipitation, "0%");
  assert.equal(summarizePeriod(forecast.properties.periods[1]).chance_of_precipitation, undefined); // null isn't "0%"
  assert.equal(summarizePeriod({ ...forecast.properties.periods[0], name: "" }).name, "6 PM Wed");
});

test("the tool gives alerts first, with what to do, and asks weather.gov with a User-Agent", async (t) => {
  clearWeatherCache();
  const requested = stubFetch(t, { "/points/": { body: point }, "/alerts/": { body: alerts }, "/forecast": { body: forecast } });
  const out = await weatherTool.run({});
  const j = JSON.parse(out.content);
  assert.equal(j.alerts[0].event, "Frost Advisory");
  assert.match(j.alerts[0].what_to_do, /protect tender plants/);
  assert.equal(j.forecast[0].temperature, "38°F");
  assert.equal(out.card.type, "weather");
  assert.ok(requested.inits.every((i) => i.headers["user-agent"]), "every request sends a User-Agent");
});

test("an unknown place is an error the model can read", async () => {
  await assert.rejects(weatherTool.run({ place: "burlington" }), /place must be one of/);
});

// The Snow Bowl's hours calendar, as its admin-ajax endpoint returned it for January 2026.
const jan2026 =
  "<table class=\"calendar-table\"><tr><th>Mon</th></tr><tr><td class=\"empty\"></td><td class='open'><strong>1</strong><br>Open from 9 a.m. to  9 p.m.</td>" +
  "<td class='open'><strong>3</strong><br>Open from 9 a.m. to 4 p.m.</td><td class='closed'><strong>5</strong><br>Closed</td></tr></table>";
const jan2027 = "<table class=\"calendar-table\"><tr><td class='closed'><strong>1</strong><br>Closed</td><td class='closed'><strong>2</strong><br>Closed</td></tr></table>";

test("Snow Bowl days read as the calendar says; a month with no open day counts as not set", () => {
  const season = parseSnowbowlMonth(jan2026, 2026, 1);
  assert.equal(season.days.get("2026-01-01"), "9 a.m. to 9 p.m.");
  assert.equal(season.days.get("2026-01-05"), "Closed");
  assert.equal(season.anyOpen, true);
  assert.equal(parseSnowbowlMonth(jan2027, 2027, 1).anyOpen, false);
});
