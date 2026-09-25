import assert from "node:assert/strict";
import { test } from "node:test";
import { openLocalD1 } from "../src/db/node-d1.js";
import { findFaculty, reviewsTool } from "../src/tools/reviews.js";

const db = openLocalD1();
await db.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY, url TEXT, title TEXT, updated TEXT, section TEXT)`);
const people = [
  ["Emma Guiberson", "college/people"],
  ["Kate (Professor) Crawford", "college/people"],
  ["Alex Lyford", "college/people"],
  ["Alex Lyford Jr", "college/people"],
  ["Gar Olson, '22", "college/people"], // a student profile
  ["Dining Halls", "dining-services"],
];
for (const [i, [title, section]] of people.entries()) {
  await db.prepare("INSERT INTO pages VALUES (?, ?, ?, NULL, ?)").bind(i, `https://www.middlebury.edu/${section}/${i}`, title, section).run();
}
const env = { DB: db };

test("a faculty name gets a RateMyProfessors search link for Middlebury", async () => {
  const out = await reviewsTool.run({ professor: "Emma Guiberson" }, env);
  assert.equal(out.card.type, "reviews");
  assert.equal(out.card.url, "https://www.ratemyprofessors.com/search/professors/605?q=Emma%20Guiberson");
  assert.equal(out.card.profile, "https://www.middlebury.edu/college/people/0");
  assert.match(out.content, /can't see these reviews/);
});

test("names match the profile, with titles and notes ignored", async () => {
  assert.equal((await findFaculty(db, "Professor Crawford")).length, 1);
  const out = await reviewsTool.run({ professor: "Kate Crawford" }, env);
  assert.equal(out.card.professor, "Kate Crawford");
});

test("no link for a name that isn't faculty, a student, or an ambiguous match", async () => {
  await assert.rejects(reviewsTool.run({ professor: "Albus Dumbledore" }, env), /no Middlebury faculty profile/);
  await assert.rejects(reviewsTool.run({ professor: "Gar Olson" }, env), /no Middlebury faculty profile/);
  await assert.rejects(reviewsTool.run({ professor: "Lyford" }, env), /several faculty profiles/);
  assert.equal((await reviewsTool.run({ professor: "Alex Lyford" }, env)).card.professor, "Alex Lyford");
  await assert.rejects(reviewsTool.run({ professor: "" }, env), /must be a name/);
});
