import assert from "node:assert/strict";
import { test } from "node:test";
import { chunk, extract, scrub } from "../scripts/page-text.js";
import { mergeCards } from "../src/chat.js";
import { openLocalD1 } from "../src/db/node-d1.js";
import { loadStatements, matchExpression, pagesTool, searchPages } from "../src/tools/pages.js";

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
// The same SQLite search the app uses, on an in-memory database.
const db = openLocalD1();
await db.batch(loadStatements(db, data));
const now = new Date("2026-09-21T12:00:00Z");

test("questions become quoted OR searches, without stopwords, plus synonyms", () => {
  assert.equal(matchExpression("How does the meal plan work?"), '"meal" OR "plan" OR "work"');
  assert.equal(matchExpression("see a doctor"), '"see" OR "doctor" OR "health" OR "medical"');
  // Search syntax a person types is quoted away, never run.
  assert.equal(matchExpression('parking" OR NEAR(x'), '"parking" OR "near"');
  assert.equal(matchExpression("the a of"), "");
});

test("the best-matching page comes first, with its passages and date", async () => {
  const [top] = await searchPages(db, "how does the meal plan work", { now });
  assert.equal(top.title, "General Information");
  assert.equal(top.updated, "2026-09-17");
  assert.match(top.passages[0].text, /unlimited meal plan/);
});

test("stemming matches word forms: 'skiing lessons' finds 'ski lessons'", async () => {
  const [top] = await searchPages(db, "skiing lessons", { now });
  assert.equal(top.title, "Winter Guide");
});

test("pages over a year old are flagged", async () => {
  const [top] = await searchPages(db, "ski lessons", { now });
  assert.equal(top.olderThanAYear, true);
  assert.equal((await searchPages(db, "meal plan", { now }))[0].olderThanAYear, undefined);
});

test("scope limits results to faculty profiles, or excludes them", async () => {
  assert.deepEqual((await searchPages(db, "chemistry research", { scope: "faculty", now })).map((r) => r.title), ["Ada Chemist"]);
  assert.ok(!(await searchPages(db, "chemistry research", { scope: "not-faculty", now })).some((r) => r.title === "Ada Chemist"));
});

test("a search with no matching words returns nothing rather than guessing", async () => {
  assert.deepEqual(await searchPages(db, "quidditch tryouts", { now }), []);
});

test("the tool reports the index date and says so when there's no database", async () => {
  const out = await pagesTool.run({ query: "visitor parking" }, { DB: db });
  assert.equal(JSON.parse(out.content).source, "middlebury.edu pages, indexed 2026-09-21");
  assert.equal(out.card.pages[0].title, "Visitor Parking Information");
  await assert.rejects(pagesTool.run({ query: "parking" }, {}), /isn't set up/);
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
