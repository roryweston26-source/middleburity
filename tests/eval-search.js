// Scores page search against tests/search-queries.json, using the same SQLite search the
// app uses (.cache/pages.db, built by npm run build:db). Free: no AI calls, no network.
//   npm run eval:search                summary and misses
//   npm run eval:search -- -v          every query's top 3
//   npm run eval:search -- --compare   score several ranking settings side by side
import { readFile } from "node:fs/promises";
import { openLocalD1 } from "../src/db/node-d1.js";
import { WEIGHTS, searchPages } from "../src/tools/pages.js";

const verbose = process.argv.includes("-v");
const db = openLocalD1(new URL("../.cache/pages.db", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const { queries } = JSON.parse(await readFile(new URL("./search-queries.json", import.meta.url), "utf8"));

async function score(options, { report = false } = {}) {
  let top1 = 0;
  let top3 = 0;
  let reciprocal = 0;
  const misses = [];
  for (const { q, expect } of queries) {
    const re = new RegExp(expect, "i");
    const urls = (await searchPages(db, q, { limit: 5, ...options })).map((r) => r.url);
    const rank = urls.findIndex((u) => re.test(u)) + 1;
    if (rank === 1) top1++;
    if (rank >= 1 && rank <= 3) top3++;
    if (rank) reciprocal += 1 / rank;
    const short = urls.slice(0, 3).map((u) => u.replace("https://www.middlebury.edu/", ""));
    if (!rank || rank > 3) misses.push({ q, expect, got: short });
    if (report && verbose) console.log(`${rank ? `#${rank}` : "--"}  ${q}\n     ${short.join("\n     ")}`);
  }
  const n = queries.length;
  return { line: `right page first: ${top1}/${n} · in top 3: ${top3}/${n} · MRR ${(reciprocal / n).toFixed(2)}`, misses };
}

if (process.argv.includes("--compare")) {
  const settings = [
    { label: "current weights", options: {} },
    { label: "no synonyms", options: { synonyms: false } },
    { label: "all columns equal", options: { weights: { title: 1, heading: 1, path: 1, body: 1 } } },
    { label: "title 5, path 3", options: { weights: { ...WEIGHTS, title: 5 } } },
    { label: "title 3, path 5", options: { weights: { ...WEIGHTS, path: 5 } } },
    { label: "title 3, heading 2, path 3", options: { weights: { ...WEIGHTS, heading: 2 } } },
    { label: "title 2, heading 1, path 2", options: { weights: { title: 2, heading: 1, path: 2, body: 1 } } },
  ];
  for (const { label, options } of settings) console.log(label.padEnd(30), (await score(options)).line);
} else {
  const { line, misses } = await score({}, { report: true });
  console.log(`\n${queries.length} queries · ${line}`);
  for (const m of misses) console.log(`MISS  "${m.q}" (want /${m.expect}/)\n      got: ${m.got.join(" | ") || "nothing"}`);
}
db.close();
