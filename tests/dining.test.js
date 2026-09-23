import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clearDiningCache, diningTool, getMenus, parseDay, todaysMenus } from "../src/tools/dining.js";
import { runTool } from "../src/tools/index.js";
import { fixture, stubMenuFeed } from "./helpers.js";

beforeEach(() => clearDiningCache());

test("parseDay groups items under their stations, with dietary tags", () => {
  const stations = parseDay(fixture.days.find((d) => d.date === "2026-09-21"));
  assert.equal(stations[0].name, "Main Street");
  assert.deepEqual(stations[0].items[0], { name: "Maghmour (Roasted Eggplant Stew)", tags: ["Vegan"] });
  assert.ok(stations.every((s) => s.items.length > 0));
});

test("parseDay returns nothing for a missing or empty day", () => {
  assert.deepEqual(parseDay(undefined), []);
  assert.deepEqual(parseDay({ menu_items: [] }), []);
});

test("getMenus fetches the Sunday-start week and reads the requested day", async (t) => {
  const requested = stubMenuFeed(t);
  const result = await getMenus({ date: "2026-09-21", meal: "dinner", halls: ["proctor"] });
  assert.match(requested[0], /proctor-dining-hall\/menu-type\/dinner\/2026\/09\/20\//);
  assert.equal(result.menus[0].stations[0].name, "Main Street");
});

test("getMenus says so when a day has no posted menu", async (t) => {
  stubMenuFeed(t);
  const result = await getMenus({ date: "2026-09-23", meal: "dinner", halls: ["proctor"] });
  assert.match(result.menus[0].status, /no menu posted/);
});

test("halls without a meal are skipped, unless that hall was asked about", async (t) => {
  stubMenuFeed(t);
  const all = await getMenus({ date: "2026-09-21", meal: "breakfast" });
  assert.deepEqual(all.menus.map((m) => m.hall), ["proctor", "ross"]);
  const asked = await getMenus({ date: "2026-09-21", meal: "breakfast", halls: ["atwater"] });
  assert.match(asked.menus[0].status, /no breakfast menu/);
});

test("a failing feed becomes a status, not a crash", async (t) => {
  stubMenuFeed(t, { status: 500 });
  const result = await getMenus({ date: "2026-09-21", meal: "dinner", halls: ["ross"] });
  assert.match(result.menus[0].status, /couldn't load/);
});

test("the tool hands the model compact text and the app a card", async (t) => {
  stubMenuFeed(t);
  const out = await diningTool.run({ date: "2026-09-21", meal: "dinner", halls: ["proctor"] });
  const forModel = JSON.parse(out.content);
  assert.equal(forModel.menus[0].stations[0].items[0], "Maghmour (Roasted Eggplant Stew) [Vegan]");
  assert.match(forModel.note, /not allergy guarantees/);
  assert.equal(out.card.type, "menu");
  assert.match(out.card.menus[0].url, /nutrislice\.com\/menu\/proctor-dining-hall\/dinner\/2026-09-21$/);
});

test("bad tool input comes back as an error the model can read", async () => {
  const out = await runTool("get_dining_menu", { date: "tonight" });
  assert.equal(out.isError, true);
  assert.match(out.content, /YYYY-MM-DD/);
  const unknown = await runTool("get_horoscope", {});
  assert.equal(unknown.isError, true);
});

test("the home card picks the meal from Vermont time", async (t) => {
  stubMenuFeed(t);
  const evening = await todaysMenus(new Date("2026-09-21T22:00:00Z")); // 6 PM in Vermont
  assert.equal(evening.label, "Dinner tonight");
  assert.equal(evening.date, "2026-09-21");
  const late = await todaysMenus(new Date("2026-09-22T02:30:00Z")); // 10:30 PM in Vermont
  assert.equal(late.label, "Breakfast tomorrow");
  assert.equal(late.date, "2026-09-22");
});
