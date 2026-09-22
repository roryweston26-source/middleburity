// Builds the page-search index from middlebury.edu: npm run build:pages
// Politeness: follows the site's robots.txt (Crawl-delay: 1, so one request a second),
// says who it is in its User-Agent, and stops if the site starts refusing requests.
// A local cache (.cache/pages, git-ignored) keeps each page's raw <main> HTML, so re-runs
// only fetch pages whose sitemap date changed, and extraction fixes never need a re-crawl. The app never crawls: it only reads the file this writes.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chunk, extract } from "./page-text.js";

const UA = "Middleburity/0.1 (+https://github.com/roryweston26-source/middleburity; student project)";
const SITEMAPS = [
  "https://www.middlebury.edu/sitemap.xml",
  "https://www.middlebury.edu/college/sitemap.xml",
  "https://www.middlebury.edu/library/sitemap.xml",
];
const DELAY_MS = 1000; // robots.txt: Crawl-delay: 1
const OLDEST = "2022-01-01"; // pages not touched since then are more likely stale than useful

// Student-relevant sections only. Chosen 2026-09-21 from the sitemaps; each was
// checked for being current (most pages updated 2025-26).
const SECTIONS = [
  "dining-services",
  "health-services", "center-health-wellness", "center-health-and-wellness", "counseling", "health-wellness-education", "sports-medicine",
  "public-safety", "department-public-safety", "emergency-response",
  "residential-life",
  "student-financial-services", "office-student-financial-services",
  "human-resources/student-employment",
  "teaching-learning-research", "center-teaching-learning-and-research", "center-student-success",
  "center-careers-and-internships",
  "registrar", "office-registrar",
  "information-technology-services",
  "student-engagement-belonging", "student-engagement-and-belonging", "community-standards",
  "disability-resource-center", "international-student-and-scholar-services",
  "scott-center", "charles-p-scott-center", "anderson-freeman-resource-center",
  "feminist-resource-center-chellis-house", "prism-center", "civil-rights-and-title-ix-office", "title-ix",
  "middlebury-outdoor-programs", "study-abroad", "ai",
  "college/student-life", "college/admissions", "college/orientation", "college/feb-celebration",
  "college/academics", "college/people",
  "library/services", "library/special-collections", "library/spaces", "library/collections", "library/about", "library/search-find",
];
// Old or archived material, even inside allowed sections.
const EXCLUDE = /covid|archive|-old\b|\bold-|spring-?2021|midd2021|test-page|example|\/news\//i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cacheDir = new URL("../.cache/pages/", import.meta.url);
const outFile = new URL("../src/data/pages.json", import.meta.url);

// Status 0 means the network failed even after retries: the page is skipped and not
// cached, so the next run tries it again.
async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      console.warn(`network error (${err.cause?.code ?? err.message}), attempt ${attempt}: ${url}`);
      await sleep(10000);
      continue;
    }
    if (res.ok) return { status: res.status, text: await res.text() };
    if ([403, 429].includes(res.status)) return { status: res.status, text: "" };
    if (res.status >= 500 && attempt < 3) {
      await sleep(5000);
      continue;
    }
    return { status: res.status, text: "" };
  }
  return { status: 0, text: "" };
}

async function sitemapUrls() {
  const all = [];
  for (const sitemap of SITEMAPS) {
    const index = (await get(sitemap)).text;
    await sleep(DELAY_MS);
    const pages = [...index.matchAll(/<loc>([^<]*sitemap\.xml\?page=\d+)<\/loc>/g)].map((m) => m[1]);
    for (const page of pages.length ? pages : [sitemap]) {
      const xml = page === sitemap ? index : (await get(page)).text;
      if (page !== sitemap) await sleep(DELAY_MS);
      for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
        const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
        const lastmod = (m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? "").slice(0, 10);
        if (loc) all.push({ url: loc.trim(), lastmod });
      }
    }
  }
  const seen = new Set();
  return all.filter((u) => !seen.has(u.url) && seen.add(u.url));
}

const inSection = (url) =>
  SECTIONS.some((s) => {
    const base = `https://www.middlebury.edu/${s}`;
    return url === base || url.startsWith(`${base}/`);
  });

const section = (url) =>
  url.replace("https://www.middlebury.edu/", "").split("/").slice(0, url.includes("/college/") || url.includes("/library/") ? 2 : 1).join("/");

async function main() {
  await mkdir(cacheDir, { recursive: true });
  const all = await sitemapUrls();
  const wanted = all.filter((u) => inSection(u.url) && !EXCLUDE.test(u.url) && u.lastmod >= OLDEST);
  console.log(`${all.length} URLs in the sitemaps, ${wanted.length} in scope.`);

  const pages = [];
  let fetched = 0;
  let refused = 0;
  let networkFailures = 0;
  for (const [i, { url, lastmod }] of wanted.entries()) {
    const cacheFile = new URL(createHash("sha1").update(url).digest("hex") + ".json", cacheDir);
    let entry = null;
    try {
      entry = JSON.parse(await readFile(cacheFile, "utf8"));
      if (entry.lastmod !== lastmod || !("main" in entry)) entry = null;
    } catch {
      entry = null;
    }
    if (!entry) {
      const res = await get(url);
      fetched++;
      await sleep(DELAY_MS);
      if (res.status === 0) {
        networkFailures++;
        if (networkFailures >= 10) {
          console.error("Ten network failures in a row. Stopping; the cache keeps everything so far. Nothing was written.");
          process.exit(1);
        }
        continue;
      }
      networkFailures = 0;
      if ([403, 429].includes(res.status)) {
        refused++;
        console.warn(`refused (${res.status}): ${url}`);
        if (refused >= 5) {
          console.error("The site is refusing requests. Stopping, as a polite crawler should. Nothing was written.");
          process.exit(1);
        }
        continue;
      }
      const start = res.text.indexOf("<main");
      const end = res.text.indexOf("</main>");
      const main = res.status === 200 && start >= 0 && end > start ? res.text.slice(start, end + 7) : null;
      entry = { url, lastmod, status: res.status, main };
      await writeFile(cacheFile, JSON.stringify(entry));
    }
    const page = entry.main ? extract(entry.main) : null;
    if (page?.title && page.sections.length) pages.push({ ...entry, page });
    if ((i + 1) % 100 === 0) console.log(`${i + 1}/${wanted.length} (${fetched} fetched, rest from cache)`);
  }

  const out = { builtOn: new Date().toISOString().slice(0, 10), pages: [], chunks: [] };
  for (const entry of pages) {
    const id = out.pages.length;
    const pieces = chunk(entry.page.sections);
    if (!pieces.length) continue;
    out.pages.push({ url: entry.url, title: entry.page.title, updated: entry.lastmod, section: section(entry.url) });
    for (const c of pieces) out.chunks.push({ p: id, h: c.heading, t: c.text });
  }
  await writeFile(outFile, JSON.stringify(out));
  console.log(`Wrote ${out.pages.length} pages, ${out.chunks.length} passages (${fetched} fetched this run).`);
}

await main();
