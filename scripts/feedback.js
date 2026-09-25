// Prints the feedback testers sent on answers (👍 / 👎, src/feedback.js), newest first.
//   npm run feedback              production (Cloudflare D1; needs `npx wrangler login`)
//   npm run feedback -- --local   the local dev server's database (.cache/pages.db)
//   npm run feedback -- --days=3  only the last few days (default 14)
//   npm run feedback -- --down    only thumbs down
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const local = args.includes("--local");
const downOnly = args.includes("--down");
const days = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1]) || 14;
const since = new Date(Date.now() - days * 864e5).toISOString();
const sql = `SELECT at, rating, question, answer, context, note, tools, cards, model FROM feedback WHERE at >= '${since}'${downOnly ? " AND rating = 'down'" : ""} ORDER BY at DESC`;

function rows() {
  if (local) {
    if (!existsSync(".cache/pages.db")) return [];
    const db = new DatabaseSync(".cache/pages.db");
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'feedback'").get();
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
  // Before the first feedback, the table doesn't exist yet.
  if (/no such table/.test(String(err.stdout ?? err.message))) found = [];
  else throw err;
}

const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
const ups = found.filter((r) => r.rating === "up").length;
const which = downOnly ? "thumbs-down feedback" : `feedback (${ups} 👍, ${found.length - ups} 👎)`;
console.log(`${found.length} ${which} in the last ${days} days${local ? ", local" : ""}.\n`);
for (const r of found) {
  console.log(`${r.rating === "up" ? "👍" : "👎"} ${when(r.at)} · ${r.model ?? "?"} · ${r.tools ?? "no lookups"}${r.cards ? ` · cards: ${r.cards}` : ""}`);
  for (const t of JSON.parse(r.context ?? "[]")) console.log(`  (earlier) ${t.role}: ${t.content.replace(/\s+/g, " ")}`);
  console.log(`  Q: ${r.question}`);
  console.log(`  A: ${r.answer.replace(/\n+/g, "\n     ")}`);
  if (r.note) console.log(`  NOTE: ${r.note}`);
  console.log("");
}
