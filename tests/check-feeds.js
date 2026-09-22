// Checks the live sources still look the way the code expects. Free to run (no AI calls).
// Run it when something looks off, and before any demo: npm run check:feeds
import { getGames } from "../src/tools/athletics.js";
import { getMenus } from "../src/tools/dining.js";
import { getEvents } from "../src/tools/events.js";
import { OFFICES } from "../src/tools/offices.js";

let problems = 0;

// Sports: the feed should parse into games, and some should be upcoming.
try {
  const upcoming = await getGames({ limit: 10 });
  const recent = await getGames({ direction: "recent", limit: 10 });
  const next = upcoming.games[0];
  console.log(`Athletics: ${upcoming.games.length} upcoming shown, ${recent.games.filter((g) => g.result).length} recent results.`);
  if (next) console.log(`  next: ${next.sport} ${next.home ? "vs" : "at"} ${next.opponent}, ${next.start}`);
  if (!upcoming.games.length && !recent.games.length) {
    problems++;
    console.log("  FAIL  no games parsed. The feed may have changed shape.");
  }
} catch (err) {
  problems++;
  console.log(`  FAIL  athletics feed: ${err.message}`);
}

// Events: the feed should parse, and posted events should have names, times and links.
try {
  const week = await getEvents({ to: new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10), limit: 50 });
  console.log(`Events: ${week.total} in the next 7 days.`);
  if (week.events.some((e) => /zoom\.us|pwd=/i.test(JSON.stringify(e)))) {
    problems++;
    console.log("  FAIL  a meeting link got through. Check normalizeEvent.");
  }
} catch (err) {
  problems++;
  console.log(`  FAIL  events feed: ${err.message}`);
}
console.log("");

const result = await getMenus();
console.log(`Dining menus for ${result.date}:`);
for (const m of result.menus) {
  if (m.stations) {
    const items = m.stations.reduce((n, s) => n + s.items.length, 0);
    console.log(`  ok    ${m.hallName} ${m.meal}: ${m.stations.length} stations, ${items} items`);
  } else {
    if (/couldn't load/.test(m.status)) problems++;
    console.log(`  --    ${m.hallName} ${m.meal}: ${m.status}`);
  }
}
if (!result.menus.some((m) => m.stations)) {
  console.log("  No hall has a parsed menu today. Either everything is closed or the feed changed shape.");
  problems++;
}

// A redirect usually means the office was renamed or moved, so update offices.js.
console.log("\nOffice links:");
const UA = "Mozilla/5.0 (compatible; Middleburity link check)";
for (const [id, office] of Object.entries(OFFICES)) {
  try {
    const res = await fetch(office.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
    const moved = res.url.replace(/\/$/, "") !== office.url.replace(/\/$/, "");
    if ([401, 403, 429].includes(res.status)) {
      // Some sites refuse scripted requests. That isn't a dead link, so check it by hand.
      console.log(`  --    ${id}: the site refuses scripted checks (${res.status}); open ${office.url} by hand`);
    } else if (!res.ok) {
      problems++;
      console.log(`  FAIL  ${id}: ${res.status} ${office.url}`);
    } else if (moved) {
      problems++;
      console.log(`  MOVED ${id}: now redirects to ${res.url}`);
    } else {
      console.log(`  ok    ${id}`);
    }
  } catch (err) {
    problems++;
    console.log(`  FAIL  ${id}: ${err.message}`);
  }
}

// Page search: the index exists, isn't stale, and still finds a page it always should.
console.log("\nPage index:");
try {
  const { default: data } = await import("../src/data/pages.json", { with: { type: "json" } });
  const ageDays = Math.round((Date.now() - new Date(`${data.builtOn}T12:00:00Z`)) / 864e5);
  console.log(`  built ${data.builtOn} (${ageDays} days ago): ${data.pages.length} pages, ${data.chunks.length} passages`);
  if (ageDays > 30) {
    problems++;
    console.log("  STALE the index is over a month old. Run npm run build:pages.");
  }
  const { createPageSearch } = await import("../src/tools/pages.js");
  const [top] = createPageSearch(data).search("dining hall hours meal plan");
  if (!top || !top.url.includes("dining-services")) {
    problems++;
    console.log(`  FAIL  "dining hall hours meal plan" should find a Dining Services page, got ${top?.url ?? "nothing"}`);
  } else {
    console.log(`  ok    sample search finds ${top.url}`);
  }
} catch {
  problems++;
  console.log("  FAIL  no index yet. Run npm run build:pages.");
}

console.log(problems ? `\n${problems} problem(s) found.` : "\nAll sources look fine.");
process.exitCode = problems ? 1 : 0;
