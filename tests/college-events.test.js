import assert from "node:assert/strict";
import { test } from "node:test";
import { clearCollegeEventsCache, getCollegeEvents, parseListing } from "../src/tools/college-events.js";

// The listing's markup, as middlebury.edu/events served it on 2026-09-24.
const item = ({ start, title, slug, sponsor, student = false, about = "", place = "", publicTag = false }) => `
<article class="d-flex" aria-labelledby="midd-event-1-header">
  <time datetime="${start}" class="text-center"><span>Sep</span><span>26</span></time>
  <div class="w-100 pl-3 clearfix">
    <h3 class="h3" id="midd-event-1-header"><a href="/events/event/${slug}" title="${title}"><span>${title}</span></a></h3>
    <time datetime="${start}" class="d-block font-medium">7:00 PM ET</time>
    <dl class="mb-5 mt-2"><div class="mb-2"><dt>Sponsored by:</dt>
      <dd class="d-inline">${student ? `<span class="midd-student-org"><a href="/events/organizations/x">${sponsor}</a></span>` : `<span>${sponsor}</span>`}</dd></div></dl>
    <div class="f3 my-3 typography">${about}</div>
    <p class="f3 font-medium">${place}<br></p>
    ${publicTag ? "<span>Open to the Public</span>" : ""}
  </div>
</article>`;

const page = (...items) => `<main>${items.join("")}</main>`;
const WORKSHOP = { start: "2026-09-26T15:00:00-04:00", title: "PLAYWRITING WORKSHOP with John Cariani", slug: "playwriting", sponsor: "Theatre", about: "<p>A workshop &amp; talk.</p>", place: "Mahaney Arts Center 232", publicTag: true };
const SPIN = { start: "2026-09-26T07:00:00-04:00", title: "YOUPOWER Spin Class", slug: "spin", sponsor: "Youpower", student: true, place: "YouPower Spinning Room" };
const GAME = { start: "2026-09-26T12:00:00-04:00", title: "Volleyball vs Hamilton", slug: "vb", sponsor: "Women's Volleyball Team", place: "Pepin Gymnasium", publicTag: true };
const FILM = { start: "2026-09-27T17:00:00-04:00", title: "Sleepless in Middlebury", slug: "film", sponsor: "Film &amp; Media Culture", place: "Dana Auditorium" };

test("each listed event keeps its start, link, sponsor, text, place and audience", () => {
  const [e] = parseListing(page(item(WORKSHOP)));
  assert.deepEqual(e, {
    name: "PLAYWRITING WORKSHOP with John Cariani",
    url: "https://www.middlebury.edu/events/event/playwriting",
    start: "2026-09-26T19:00:00.000Z",
    org: "Theatre",
    studentOrg: false,
    description: "A workshop & talk.",
    location: "Mahaney Arts Center 232",
    public: true,
  });
  assert.equal(parseListing(page(item(SPIN)))[0].studentOrg, true);
});

test("student-group events and varsity games are left to Presence and get_games", async () => {
  clearCollegeEventsCache();
  const fetchImpl = async () => new Response(page(item(SPIN), item(GAME), item(WORKSHOP)));
  const r = await getCollegeEvents({ from: "2026-09-26", now: new Date("2026-09-24T12:00:00Z") }, fetchImpl, async () => {});
  assert.deepEqual(r.events.map((e) => e.name), ["PLAYWRITING WORKSHOP with John Cariani"]);
});

test("pages are fetched a second apart only as far as the range needs, then shared", async () => {
  clearCollegeEventsCache();
  const full = Array.from({ length: 20 }, () => item(WORKSHOP));
  const pages = [page(...full), page(item(FILM))];
  const urls = [];
  const waits = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(pages[urls.length - 1]);
  };
  const now = new Date("2026-09-24T12:00:00Z");
  const sat = await getCollegeEvents({ from: "2026-09-26", now }, fetchImpl, async (ms) => waits.push(ms));
  assert.equal(urls.length, 2); // page 0 ended on the 26th, so page 1 was needed to see past it
  assert.match(urls[1], /start-date=2026-09-26&page=1$/);
  assert.deepEqual(waits, [1000]);
  assert.equal(sat.total, 20);
  const weekend = await getCollegeEvents({ from: "2026-09-26", to: "2026-09-27", now }, fetchImpl, async (ms) => waits.push(ms));
  assert.equal(urls.length, 2); // the short second page ended the listing; nothing more to fetch
  assert.equal(weekend.events.at(-1)?.name ?? "", "PLAYWRITING WORKSHOP with John Cariani");
  assert.equal(weekend.total, 21);
});
