import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, extract, scrub } from "../scripts/page-text.js";
import { mergeCards } from "../src/chat.js";
import { createPageSearch, tokenize } from "../src/tools/pages.js";

// A tiny made-up index in the same shape scripts/build-pages.js writes.
const data = {
  builtOn: "2026-09-21",
  pages: [
    { url: "https://www.middlebury.edu/dining-services/general-information", title: "General Information", updated: "2026-09-17", section: "dining-services" },
    { url: "https://www.middlebury.edu/public-safety/visitor-parking", title: "Visitor Parking Information", updated: "2026-08-01", section: "public-safety" },
    { url: "https://www.middlebury.edu/college/people/a-chemist", title: "Ada Chemist", updated: "2026-09-01", section: "college/people" },
    { url: "https://www.middlebury.edu/residential-life/old-guide", title: "Winter Guide", updated: "2023-01-10", section: "residential-life" },
  ],
  chunks: [
    { p: 0, h: "Ross Dining Hall", t: "Monday through Friday lunch 11:00am to 2:00pm with limited options until 2:30pm." },
    { p: 0, h: "Unlimited Plan", t: "All on campus students are signed up for the unlimited meal plan with $25 of declining balance per semester." },
    { p: 1, h: "Overnight guests", t: "Guests parking overnight must register the vehicle and park in the visitor section of the Mahaney Arts Center lot." },
    { p: 2, h: "Ada Chemist", t: "Professor of Chemistry. Research in medicinal chemistry; undergraduate research students welcome." },
    { p: 3, h: "Skiing", t: "Students can take ski lessons at the Snow Bowl." },
  ],
};
const index = createPageSearch(data);
const now = new Date("2026-09-21T12:00:00Z");

test("tokenize drops stopwords and folds simple plurals and -ing", () => {
  assert.deepEqual(tokenize("How do the meal plans work?"), ["meal", "plan", "work"]);
  assert.deepEqual(tokenize("skiing lessons"), ["ski", "lesson"]);
});

test("the best-matching page comes first, with its passages and date", () => {
  const [top] = index.search("how does the meal plan work", { now });
  assert.equal(top.title, "General Information");
  assert.equal(top.updated, "2026-09-17");
  assert.match(top.passages[0].text, /unlimited meal plan/);
});

test("pages over a year old are flagged", () => {
  const [top] = index.search("ski lessons", { now });
  assert.equal(top.title, "Winter Guide");
  assert.equal(top.olderThanAYear, true);
  assert.equal(index.search("meal plan", { now })[0].olderThanAYear, undefined);
});

test("scope limits results to faculty profiles, or excludes them", () => {
  assert.deepEqual(index.search("chemistry research", { scope: "faculty", now }).map((r) => r.title), ["Ada Chemist"]);
  assert.ok(!index.search("chemistry research", { scope: "not-faculty", now }).some((r) => r.title === "Ada Chemist"));
});

test("a search with no matching words returns nothing rather than guessing", () => {
  assert.deepEqual(index.search("quidditch tryouts", { now }), []);
});

test("extract keeps <main> text, splits on headings, and drops menus and scripts", () => {
  const html = `<nav>Site menu</nav><main><nav>Breadcrumb</nav><h1>Parking</h1><p>Intro text here.</p>
    <h2>Visitors</h2><p>Visitors park in the MAC lot.</p><script>track()</script></main><footer>Footer</footer>`;
  const page = extract(html);
  assert.equal(page.title, "Parking");
  assert.deepEqual(page.sections.map((s) => s.heading), ["Parking", "Visitors"]);
  assert.ok(!JSON.stringify(page).match(/Site menu|Breadcrumb|track\(\)|Footer/));
});

test("headings that wrap across lines or sit in list items still count as headings", () => {
  const page = extract("<main><h1>Prof</h1><ul><li><h3>\n  <p>ENVS 0209</p>\n  Gender Health\n</h3></li></ul><p>About the course.</p></main>");
  assert.equal(page.sections[0].heading, "ENVS 0209 Gender Health");
});

test("short sections merge into the next but keep their own heading in the text", () => {
  const sections = [
    { heading: "Atwater", lines: ["Lunch 11 to 2."] },
    { heading: "Meal Plans", lines: [Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")] },
  ];
  const [first] = chunk(sections);
  assert.match(first.text, /^Atwater: Lunch 11 to 2\. Meal Plans: word0/);
});

test("contact details are scrubbed from indexed text", () => {
  assert.equal(scrub("Email jdoe@middlebury.edu or call 802-443-5000.").replace(/\s+/g, " "), "Email or call .");
});

test("several page searches merge into one card without repeats", () => {
  const card = (urls) => ({ type: "pages", pages: urls.map((url) => ({ url, title: url })), source: {} });
  const merged = mergeCards([card(["a", "b"]), { type: "menu" }, card(["b", "c"])]);
  assert.deepEqual(merged.map((c) => c.type), ["menu", "pages"]);
  assert.deepEqual(merged[1].pages.map((p) => p.url), ["a", "b", "c"]);
});
