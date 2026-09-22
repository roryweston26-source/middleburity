import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { athleticsTool, clearAthleticsCache, gameDate, getGames, matchesSport, parseIcs } from "../src/tools/athletics.js";
import { athleticsIcs, stubFetch } from "./helpers.js";

beforeEach(() => clearAthleticsCache());
const now = new Date("2026-09-21T18:00:00Z"); // 2 PM in Vermont
const feed = (t, status = 200) => stubFetch(t, { "calendar.ics": { status, body: athleticsIcs } });

test("parseIcs reads sport, opponent, home venue, and results", () => {
  const games = parseIcs(athleticsIcs);
  const union = games.find((g) => g.opponent === "Union College");
  assert.equal(union.sport, "Field Hockey");
  assert.equal(union.home, true);
  assert.equal(union.venue, "Peter Kohn Field");
  assert.equal(union.result, "W 8-0");
  assert.match(union.url, /game_id=\d+&sport_id=\d+$/);

  const wesleyan = games.find((g) => g.opponent === "Wesleyan University");
  assert.equal(wesleyan.home, false);
  assert.equal(wesleyan.place, "Middletown, CT");
  assert.equal(wesleyan.result, "L 1-4");
});

test("neutral-site games aren't counted as home games", () => {
  const cnu = parseIcs(athleticsIcs).find((g) => g.opponent === "Christopher Newport University");
  assert.equal(cnu.home, false);
  assert.match(cnu.place, /Harvard/);
});

test("meets with no posted time are all-day, on the right date", () => {
  const meet = parseIcs(athleticsIcs).find((g) => g.allDay);
  assert.match(meet.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(gameDate(meet), meet.start);
});

test("sport matching is word-exact, so men's never matches women's", () => {
  assert.ok(matchesSport("Women's Soccer", "soccer"));
  assert.ok(matchesSport("Women's Soccer", "womens soccer"));
  assert.ok(!matchesSport("Women's Soccer", "men's soccer"));
  assert.ok(matchesSport("Men's Soccer", "mens soccer"));
  assert.ok(matchesSport("Field Hockey", "hockey"));
});

test("upcoming games start from now, soonest first; recent results go backwards", async (t) => {
  feed(t);
  const upcoming = await getGames({ sport: "field hockey" }, now);
  assert.equal(upcoming.games[0].opponent, "Bowdoin College");
  assert.ok(upcoming.games.every((g) => !g.result));
  const recent = await getGames({ sport: "field hockey", direction: "recent" }, now);
  assert.equal(recent.games[0].opponent, "Union College");
});

test("home_only keeps only games at Middlebury", async (t) => {
  feed(t);
  const home = await getGames({ homeOnly: true }, now);
  assert.ok(home.games.length > 0);
  assert.ok(home.games.every((g) => g.home));
});

test("an unknown sport tells the model which sports exist", async (t) => {
  feed(t);
  await assert.rejects(getGames({ sport: "quidditch" }, now), /Sports: Field Hockey/);
});

// Middlebury's athletics server answers an empty 200 when a request has no User-Agent,
// which silently emptied the schedule in production once. Every source request says who it is.
test("requests to Middlebury sources identify themselves", async (t) => {
  const requested = feed(t);
  await getGames({}, now);
  assert.match(requested.inits[0].headers["user-agent"], /^Middleburity\/[\d.]+ \(\+https:\/\/github\.com\//);
});

test("the feed is fetched once, then cached", async (t) => {
  const requested = feed(t);
  await getGames({}, now);
  await getGames({ sport: "soccer" }, now);
  assert.equal(requested.length, 1);
});

test("the tool gives the model plain rows and the app a card", async (t) => {
  feed(t);
  const out = await athleticsTool.run({ sport: "field hockey", home_only: true });
  const data = JSON.parse(out.content);
  assert.ok(data.games.every((g) => g.where.startsWith("home, ")));
  assert.equal(out.card.type, "games");
  assert.equal(out.card.source.url, "https://athletics.middlebury.edu/calendar");
});
