// Builds the page-search index from Middlebury's websites: npm run build:pages
// Politeness: one request a second (middlebury.edu's robots.txt asks for Crawl-delay: 1;
// the Handbook has no robots.txt and gets the same pace), an honest User-Agent, and it
// stops if a site starts refusing requests.
// A local cache (.cache/pages, git-ignored) keeps each page's raw <main> HTML, so re-runs
// only fetch pages whose sitemap date changed, and extraction fixes never need a re-crawl.
// The app never crawls: it only reads the file this writes.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chunk, dedupePassages, extract } from "./page-text.js";

const UA = "Middleburity/0.1 (+https://github.com/roryweston26-source/middleburity; student project)";
const DELAY_MS = 1000;
const OLDEST = "2022-01-01"; // pages not touched since then are more likely stale than useful

// middlebury.edu: student-relevant sections only. Chosen 2026-09-21 from the sitemaps; each
// was checked for being current (most pages updated 2025-26).
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
// Single pages whose sections are otherwise out of scope (the library's own news and staff pages aren't wanted;
// the rest of Facilities, Business Services and the arts site is for staff and visitors).
const SINGLE_PAGES = [
  "library", "library/collection-locations",
  "facilities-services/student-mail-center", "facilities-services/who-do-i-call", "business-services/laundry",
  "college/arts/about/transportation-options", "college/box-office/directions-parking-and-transportation",
];
// Old or archived material, even inside allowed sections.
const EXCLUDE = /covid|archive|-old\b|\bold-|spring-?2021|midd2021|test-page|example|\/news\//i;

const trim = (url) => url.replace(/\/+$/, "");

const SITES = [
  {
    host: "https://www.middlebury.edu/",
    sitemaps: [
      "https://www.middlebury.edu/sitemap.xml",
      "https://www.middlebury.edu/college/sitemap.xml",
      "https://www.middlebury.edu/library/sitemap.xml",
    ],
    include: (url) =>
      SINGLE_PAGES.some((s) => trim(url) === `https://www.middlebury.edu/${s}`) ||
      SECTIONS.some((s) => {
        const base = `https://www.middlebury.edu/${s}`;
        return trim(url) === base || url.startsWith(`${base}/`);
      }),
    // Sitemap dates here track real page edits.
    dated: true,
    section: (url) => {
      const parts = url.replace("https://www.middlebury.edu/", "").split("/");
      return parts.slice(0, ["college", "library"].includes(parts[0]) ? 2 : 1).join("/");
    },
  },
  {
    // The Middlebury Handbook: the policies that apply to everyone, and the undergraduate
    // College's own. The parts for the Institute, online programs, schools abroad and the
    // Language Schools are left out.
    host: "https://handbook.middlebury.edu/",
    sitemaps: ["https://handbook.middlebury.edu/sitemap-index.xml"],
    // Staff employment and faculty tenure rules live in the College part too; they'd crowd
    // out student answers ("leave of absence" finding staff parental leave), so they're skipped.
    include: (url) =>
      /\/pages\/(i-policies-for-all|ii-ug-college-policies)\//.test(url) && !/\/ii-ug-college-policies\/(employee|faculty)\//.test(url),
    // Every Handbook sitemap date is the site's last rebuild, not when a policy changed,
    // so the index shows no date rather than a misleading one.
    dated: false,
    section: (url) => (url.includes("/ii-ug-college-policies/") ? "handbook/college-policies" : "handbook/policies-for-all"),
  },
  {
    // Tri-Valley Transit's Regional Connections page: which trains, intercity buses and airport
    // links serve Addison County. Middlebury's international-student pages send students there.
    // Its robots.txt asks for 10 seconds between requests, and its content sits in <article>.
    host: "https://www.trivalleytransit.org/",
    sitemaps: ["https://www.trivalleytransit.org/page-sitemap.xml"],
    include: (url) => trim(url) === "https://www.trivalleytransit.org/regional-connections",
    dated: true,
    delayMs: 10000,
    container: "article",
    section: () => "outside/trivalleytransit",
  },
];

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

// Reads a sitemap, following sitemap indexes (<sitemap><loc>) and Drupal's ?page=N splits.
async function readSitemap(url, out, delay = DELAY_MS) {
  const xml = (await get(url)).text;
  await sleep(delay);
  const children = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  for (const child of children) await readSitemap(child, out, delay);
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = (m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? "").slice(0, 10);
    if (loc) out.push({ url: loc.trim(), lastmod });
  }
}

async function main() {
  await mkdir(cacheDir, { recursive: true });
  const wanted = [];
  for (const site of SITES) {
    const found = [];
    for (const sitemap of site.sitemaps) await readSitemap(sitemap, found, site.delayMs ?? DELAY_MS);
    const seen = new Set();
    const keep = found.filter(
      (u) => !seen.has(u.url) && seen.add(u.url) && site.include(u.url) && !EXCLUDE.test(u.url) && (!site.dated || u.lastmod >= OLDEST),
    );
    console.log(`${site.host}: ${found.length} URLs in the sitemaps, ${keep.length} in scope.`);
    for (const u of keep) wanted.push({ ...u, site });
  }

  const pages = [];
  let fetched = 0;
  let refused = 0;
  let networkFailures = 0;
  for (const [i, { url, lastmod, site }] of wanted.entries()) {
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
      await sleep(site.delayMs ?? DELAY_MS);
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
          console.error("A site is refusing requests. Stopping, as a polite crawler should. Nothing was written.");
          process.exit(1);
        }
        continue;
      }
      // The cache keeps the page's content as <main>...</main>, whatever element the site uses.
      const tag = site.container ?? "main";
      const start = res.text.indexOf(`<${tag}`);
      const end = res.text.indexOf(`</${tag}>`);
      const inner = res.status === 200 && start >= 0 && end > start ? res.text.slice(res.text.indexOf(">", start) + 1, end) : null;
      const main = inner === null ? null : `<main>${inner}</main>`;
      entry = { url, lastmod, status: res.status, main };
      await writeFile(cacheFile, JSON.stringify(entry));
    }
    const page = entry.main ? extract(entry.main) : null;
    if (page?.title && page.sections.length) pages.push({ ...entry, page, site });
    if ((i + 1) % 100 === 0) console.log(`${i + 1}/${wanted.length} (${fetched} fetched, rest from cache)`);
  }

  const out = { builtOn: new Date().toISOString().slice(0, 10), pages: [], chunks: [] };
  for (const entry of pages) {
    const id = out.pages.length;
    const pieces = chunk(entry.page.sections);
    if (!pieces.length) continue;
    out.pages.push({
      url: entry.url,
      title: entry.page.title,
      updated: entry.site.dated ? entry.lastmod || null : null,
      section: entry.site.section(entry.url),
    });
    for (const c of pieces) out.chunks.push({ p: id, h: c.heading, t: c.text });
  }
  const { removed, ...clean } = dedupePassages(out);
  await writeFile(outFile, JSON.stringify(clean));
  console.log(`Wrote ${clean.pages.length} pages, ${clean.chunks.length} passages (${removed} boilerplate repeats dropped, ${fetched} fetched this run).`);
}

await main();
