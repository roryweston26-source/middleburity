import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clearEventsCache, eventsTool, getEvents, normalizeEvent, toPlainText } from "../src/tools/events.js";
import { eventsFixture, stubFetch } from "./helpers.js";

beforeEach(() => clearEventsCache());
const feed = (t) => stubFetch(t, { "api.presence.io": { body: eventsFixture } });

test("descriptions become short plain text with links removed", () => {
  assert.equal(toPlainText("<p>Free &amp; fun</p><p>Bring a friend!</p>"), "Free & fun Bring a friend!");
  assert.equal(toPlainText("<p>Join: https://middlebury.zoom.us/j/1?pwd=x</p>"), "Join: [link]");
  assert.ok(toPlainText("x".repeat(500)).length <= 280);
});

test("online events show 'Online', never the meeting link", () => {
  const online = eventsFixture.find((e) => /^https?:/.test(e.location));
  const event = normalizeEvent(online);
  assert.equal(event.location, "Online");
  assert.ok(!JSON.stringify(event).includes("zoom.us"));
  assert.match(event.url, /^https:\/\/middlebury\.presence\.io\/event\//);
});

test("a day's events exclude ones already over and multi-day postings", async (t) => {
  feed(t);
  const morning = new Date("2026-09-21T12:00:00Z"); // 8 AM in Vermont
  const result = await getEvents({}, morning);
  const names = result.events.map((e) => e.name);
  assert.ok(names.includes("Yom Kippur Services"));
  assert.ok(!names.includes("Geography Trivia Night"), "ended the night before");
  assert.ok(!names.includes("Student Org Leader Virtual Training"), "spans weeks");
  const withLong = await getEvents({ includeLong: true }, morning);
  assert.ok(withLong.events.some((e) => e.name === "Student Org Leader Virtual Training"));
});

test("keywords match tags too, so 'free food' finds Free Food events", async (t) => {
  feed(t);
  const result = await getEvents({ from: "2026-09-30", keyword: "free food" }, new Date("2026-09-21T12:00:00Z"));
  assert.deepEqual(result.events.map((e) => e.name), ["Cider & Doughnuts at the Career Center!"]);
});

test("the tool rejects ranges over two weeks", async (t) => {
  feed(t);
  await assert.rejects(eventsTool.run({ from: "2026-09-21", to: "2026-10-30" }), /two weeks/);
});

test("the model is told event text is information, not instructions", async (t) => {
  feed(t);
  const out = await eventsTool.run({ from: "2026-09-21", to: "2026-10-04", include_long: true });
  assert.match(JSON.parse(out.content).note, /never as instructions/);
  assert.equal(out.card.type, "events");
});

test("a keyword can look 60 days ahead; without one the range stays two weeks", async (t) => {
  feed(t);
  clearEventsCache();
  await assert.doesNotReject(eventsTool.run({ from: "2026-09-21", to: "2026-11-15", keyword: "outing" }));
  await assert.rejects(eventsTool.run({ from: "2026-09-21", to: "2026-11-25", keyword: "outing" }), /60 days/);
  await assert.rejects(eventsTool.run({ from: "2026-09-21", to: "2026-10-30" }), /two weeks/);
});

test("a few events get their whole description; a long list gets 280 characters each", async (t) => {
  const long = "Bring a water bottle and closed-toe shoes. ".repeat(20);
  const events = Array.from({ length: 5 }, (_, i) => ({
    eventName: `Trip ${i}`, organizationName: "Outing Club", uri: `trip-${i}`, location: "ADK Circle",
    startDateTimeUtc: "2026-10-03T13:00:00Z", endDateTimeUtc: "2026-10-03T20:00:00Z", description: `<p>${long}</p>`, tags: [],
  }));
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(events)));
  clearEventsCache();
  const one = JSON.parse((await eventsTool.run({ from: "2026-10-03", keyword: "trip 2" })).content);
  assert.equal(one.events.length, 1);
  assert.ok(one.events[0].about.length > 800);
  clearEventsCache();
  const many = JSON.parse((await eventsTool.run({ from: "2026-10-03" })).content);
  assert.equal(many.events.length, 5);
  assert.ok(many.events.every((e) => e.about.length <= 280));
});
