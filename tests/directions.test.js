import assert from "node:assert/strict";
import { test } from "node:test";
import { directions, directionsTool, findPlace, mapsUrl } from "../src/tools/directions.js";
import { PLACES } from "../src/data/places.js";

test("every place has a name, a kind, and coordinates on campus", () => {
  for (const p of PLACES) {
    assert.ok(p.name && p.kind, JSON.stringify(p));
    assert.ok(p.lat > 43.99 && p.lat < 44.03 && p.lon > -73.21 && p.lon < -73.15, `${p.name} is off campus`);
  }
});

test("findPlace matches on whole words and prefers the shortest name", () => {
  assert.equal(findPlace("Hepburn").place.name, "Hepburn Hall");
  assert.equal(findPlace("proctor").place.name, "Proctor Hall");
  assert.equal(findPlace("Kohn Field").place.name, "Peter Kohn Field");
  assert.equal(findPlace("bi hall").place.name, "McCardell Bicentennial Hall");
  assert.equal(findPlace("the MAC").place.name, "Mahaney Arts Center");
  assert.equal(findPlace("Narnia").place, null);
});

test("a walking link uses Google Maps' documented directions URL", () => {
  const url = new URL(mapsUrl({ lat: 44.0036, lon: -73.1759 }, { lat: 44.0089, lon: -73.1797 }));
  assert.equal(url.origin + url.pathname, "https://www.google.com/maps/dir/");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("travelmode"), "walking");
  assert.equal(url.searchParams.get("destination"), "44.0036,-73.1759");
  assert.equal(url.searchParams.get("origin"), "44.0089,-73.1797");
});

test("dorm to field gives both names and a straight-line distance", () => {
  const d = directions({ from: "Hepburn Hall", to: "Peter Kohn Field" });
  assert.equal(d.from, "Hepburn Hall");
  assert.equal(d.to, "Peter Kohn Field");
  assert.ok(d.straightLineMiles > 0 && d.straightLineMiles < 2);
});

test("a venue with no confirmed location says so and falls back to the athletics complex", () => {
  const d = directions({ to: "Natatorium" });
  assert.equal(d.to, "Peterson Family Athletics Complex");
  assert.equal(d.askedFor, "Natatorium");
  assert.match(d.note, /No confirmed location for Natatorium/);
  assert.match(d.venuePage, /athletics\.middlebury\.edu\/facilities\/natatorium/);
});

test("unknown places are errors the model can read, not guesses", async () => {
  await assert.rejects(directionsTool.run({ to: "Hogwarts" }), /isn't in my list/);
});
