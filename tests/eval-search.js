// Scores page search against tests/search-queries.json. Free: no AI calls, no network.
//   npm run eval:search                summary and misses
//   npm run eval:search -- -v          every query's top 3
//   npm run eval:search -- --compare   score several ranking settings side by side
import { readFile } from "node:fs/promises";
import { createPageSearch } from "../src/tools/pages.js";

const verbose = process.argv.includes("-v");
const { default: data } = await import("../src/data/pages.json", { with: { type: "json" } });
const { queries } = JSON.parse(await readFile(new URL("./search-queries.json", import.meta.url), "utf8"));

function score(options, { report = false } = {}) {
  const search = createPageSearch(data, options).search;
  let top1 = 0;
  let top3 = 0;
  let reciprocal = 0;
  const misses = [];
  for (const { q, expect } of queries) {
    const re = new RegExp(expect, "i");
    const urls = search(q, { limit: 5 }).map((r) => r.url);
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
    { label: "current default", options: {} },
    { label: "+ page address x1", options: { urlWeight: 1 } },
    { label: "+ page address x2", options: { urlWeight: 2 } },
    { label: "+ synonyms", options: { synonyms: true } },
    { label: "+ address x2 + synonyms", options: { urlWeight: 2, synonyms: true } },
    { label: "+ address x3 + synonyms", options: { urlWeight: 3, synonyms: true } },
  ];
  for (const { label, options } of settings) console.log(label.padEnd(26), score(options).line);
} else {
  const { line, misses } = score({}, { report: true });
  console.log(`\n${queries.length} queries · ${line}`);
  for (const m of misses) console.log(`MISS  "${m.q}" (want /${m.expect}/)\n      got: ${m.got.join(" | ") || "nothing"}`);
}
