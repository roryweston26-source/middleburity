// Prints the answers testers reported ("Report this answer", src/reports.js), newest first.
//   npm run reports              production (Cloudflare D1; needs `npx wrangler login`)
//   npm run reports -- --local   the local dev server's database (.cache/pages.db)
//   npm run reports -- --days=3  only the last few days (default 14)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const local = args.includes("--local");
const days = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1]) || 14;
const since = new Date(Date.now() - days * 864e5).toISOString();
const sql = `SELECT at, question, answer, context, note, tools, cards, model FROM reports WHERE at >= '${since}' ORDER BY at DESC`;

function rows() {
  if (local) {
    if (!existsSync(".cache/pages.db")) return [];
    const db = new DatabaseSync(".cache/pages.db");
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'reports'").get();
    return hasTable ? db.prepare(sql).all() : [];
  }
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "middleburity", "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out)[0]?.results ?? [];
}

let found;
try {
  found = rows();
} catch (err) {
  // Before the first report, the table doesn't exist yet.
  if (/no such table/.test(String(err.stdout ?? err.message))) found = [];
  else throw err;
}

const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
console.log(`${found.length} report${found.length === 1 ? "" : "s"} in the last ${days} days${local ? " (local)" : ""}.\n`);
for (const r of found) {
  console.log(`— ${when(r.at)} · ${r.model ?? "?"} · ${r.tools ?? "no lookups"}${r.cards ? ` · cards: ${r.cards}` : ""}`);
  for (const t of JSON.parse(r.context ?? "[]")) console.log(`  (earlier) ${t.role}: ${t.content.replace(/\s+/g, " ")}`);
  console.log(`  Q: ${r.question}`);
  console.log(`  A: ${r.answer.replace(/\n+/g, "\n     ")}`);
  if (r.note) console.log(`  NOTE: ${r.note}`);
  console.log("");
}
