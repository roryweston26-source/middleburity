// Prints the daily usage counts (src/stats.js): questions, people, how many came back, and
// which lookups answered. Numbers only; the app keeps no questions here.
//   npm run usage              production (Cloudflare D1; needs `npx wrangler login`)
//   npm run usage -- --local   the local dev server's database (.cache/pages.db)
//   npm run usage -- --days=7  only the last few days (default 28)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { campusDate } from "../src/campus-time.js";

const args = process.argv.slice(2);
const local = args.includes("--local");
const days = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1]) || 28;
const since = campusDate(new Date(Date.now() - (days - 1) * 864e5));
const sql = `SELECT day, what, n FROM stats WHERE day >= '${since}' ORDER BY day`;

function rows() {
  if (local) {
    if (!existsSync(".cache/pages.db")) return [];
    const db = new DatabaseSync(".cache/pages.db");
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'stats'").get();
    return hasTable ? db.prepare(sql).all() : [];
  }
  // Wrangler's own script under Node, with no shell in between: a Windows shell splits the SQL apart.
  const wrangler = "node_modules/wrangler/bin/wrangler.js";
  const out = execFileSync(process.execPath, [wrangler, "d1", "execute", "middleburity", "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out)[0]?.results ?? [];
}

let found;
try {
  found = rows();
} catch (err) {
  // Before the first counted question, the table doesn't exist yet.
  if (/no such table/.test(String(err.stdout ?? err.message))) found = [];
  else throw err;
}

const byDay = new Map();
const tools = new Map();
for (const { day, what, n } of found) {
  if (!byDay.has(day)) byDay.set(day, {});
  byDay.get(day)[what] = n;
  if (what.startsWith("tool ") || what === "no lookup") tools.set(what, (tools.get(what) ?? 0) + n);
}

const total = (what) => [...byDay.values()].reduce((sum, d) => sum + (d[what] ?? 0), 0);
console.log(`Usage for the last ${days} days${local ? ", local" : ""} (from ${since}).\n`);
if (!byDay.size) {
  console.log("No questions counted yet.");
  process.exit(0);
}

const pad = (v, w) => String(v).padStart(w);
console.log(`${"day".padEnd(10)}  ${pad("questions", 9)}  ${pad("people", 6)}  ${pad("returning", 9)}  ${pad("follow-ups", 10)}  ${pad("answered", 8)}`);
for (const [day, d] of byDay) {
  console.log(`${day}  ${pad(d.questions ?? 0, 9)}  ${pad(d.visitors ?? 0, 6)}  ${pad(d.returning ?? 0, 9)}  ${pad(d["follow-ups"] ?? 0, 10)}  ${pad(d.answered ?? 0, 8)}`);
}

const questions = total("questions");
const people = total("visitors");
console.log(`\nIn all: ${questions} questions on ${byDay.size} active days, ${people} person-days (one person asking on 3 days counts 3).`);
console.log(`Returning: ${total("returning")} of ${people} person-days came from a device that had asked on an earlier day.`);
console.log(`Questions per person-day: ${(questions / Math.max(people, 1)).toFixed(1)}; follow-ups: ${total("follow-ups")}; answered: ${total("answered")}.`);

console.log("\nLookups (answers that used each; one answer can use several):");
for (const [what, n] of [...tools].sort((a, b) => b[1] - a[1])) console.log(`${pad(n, 5)}  ${what.replace(/^tool /, "")}`);
