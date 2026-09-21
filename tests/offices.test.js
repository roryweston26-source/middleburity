import assert from "node:assert/strict";
import { test } from "node:test";
import { OFFICES, officesTool } from "../src/tools/offices.js";
import { runTool } from "../src/tools/index.js";

test("every office has a name, a routing hint, and an https link", () => {
  for (const [id, office] of Object.entries(OFFICES)) {
    assert.ok(office.name, `${id} needs a name`);
    assert.ok(office.handles, `${id} needs a handles hint`);
    assert.match(office.url, /^https:\/\//, `${id} needs an https url`);
  }
});

test("the model sees every office id, and can only pick from them", () => {
  const { description, input_schema } = officesTool.definition;
  for (const id of Object.keys(OFFICES)) assert.ok(description.includes(id));
  assert.deepEqual(input_schema.properties.id.enum, Object.keys(OFFICES));
});

test("get_office returns the stored name and link as a card", async () => {
  const out = await runTool("get_office", { id: "visitor-parking" });
  assert.equal(out.card.type, "office");
  assert.equal(out.card.name, OFFICES["visitor-parking"].name);
  assert.equal(out.card.url, OFFICES["visitor-parking"].url);
  assert.match(out.card.source.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(JSON.parse(out.content), { name: out.card.name, url: out.card.url });
});

test("an unknown office is an error the model can read", async () => {
  const out = await runTool("get_office", { id: "center-for-campus-activities" });
  assert.equal(out.isError, true);
  assert.match(out.content, /id must be one of/);
});
