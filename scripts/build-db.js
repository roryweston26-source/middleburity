// Loads the crawled pages (src/data/pages.json) into SQLite full-text search:
//   .cache/pages.db      the local database dev-server.js searches
//   .cache/pages-d1.sql  the same tables as SQL, for loading into Cloudflare D1
// Run automatically by npm run build:pages; on its own with npm run build:db.
import { rm, writeFile } from "node:fs/promises";
import { openLocalD1 } from "../src/db/node-d1.js";
import { SCHEMA, loadStatements, pathWords } from "../src/tools/pages.js";

const { default: data } = await import("../src/data/pages.json", { with: { type: "json" } });

const dbFile = new URL("../.cache/pages.db", import.meta.url);
await rm(dbFile, { force: true });
const db = openLocalD1(decodeURIComponent(dbFile.pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const statements = loadStatements(db, data);
for (let i = 0; i < statements.length; i += 2000) await db.batch(statements.slice(i, i + 2000));
db.close();

// SQL text for D1. Values are escaped by doubling single quotes, the standard SQL rule.
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const lines = [...SCHEMA.map((s) => `${s};`)];
data.pages.forEach((p, id) => lines.push(`INSERT INTO pages (id, url, title, updated, section) VALUES (${[id, p.url, p.title, p.updated, p.section].map(q).join(", ")});`));
for (const c of data.chunks) {
  const page = data.pages[c.p];
  lines.push(`INSERT INTO passages (title, heading, path, body, page_id) VALUES (${[page.title, c.h, pathWords(page.url), c.t, c.p].map(q).join(", ")});`);
}
lines.push(`INSERT OR REPLACE INTO index_info (key, value) VALUES ('builtOn', ${q(data.builtOn)});`);
await writeFile(new URL("../.cache/pages-d1.sql", import.meta.url), `${lines.join("\n")}\n`);

console.log(`Search database built: ${data.pages.length} pages, ${data.chunks.length} passages (indexed ${data.builtOn}).`);
