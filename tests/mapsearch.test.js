import assert from "node:assert/strict";
import { test } from "node:test";
import { mapSearchTool } from "../src/tools/mapsearch.js";
import { isDisplayOnly } from "../src/tools/index.js";

test("a kind of business gets a Google Maps search near Middlebury, built by the server", async () => {
  const out = await mapSearchTool.run({ what: "  men's   barber " });
  assert.deepEqual(out.card, {
    type: "mapsearch",
    what: "men's barber",
    place: "Middlebury, VT",
    url: "https://www.google.com/maps/search/?api=1&query=men's%20barber%20near%20Middlebury%2C%20VT",
  });
  assert.match(out.content, /can't see the results/);
  assert.equal(isDisplayOnly("get_map_search"), true);
});

test("another town from the list works; anything else doesn't", async () => {
  assert.equal((await mapSearchTool.run({ what: "pharmacy", town: "Burlington" })).card.place, "Burlington, VT");
  await assert.rejects(mapSearchTool.run({ what: "pharmacy", town: "Boston" }), /town must be one of/);
});

test("only a few plain words: no empty searches, links, numbers or long text", async () => {
  await assert.rejects(mapSearchTool.run({ what: "" }), /must name a kind of business/);
  await assert.rejects(mapSearchTool.run({}), /must name a kind of business/);
  await assert.rejects(mapSearchTool.run({ what: "https://example.com" }), /few plain words/);
  await assert.rejects(mapSearchTool.run({ what: "barber at 12 Main St" }), /few plain words/);
  await assert.rejects(mapSearchTool.run({ what: "barber ".repeat(10) }), /few plain words/);
});
