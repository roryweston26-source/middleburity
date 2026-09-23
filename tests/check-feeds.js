// Checks the live sources still look the way the code expects. Free to run (no AI calls).
// Run it when something looks off, and before any demo: npm run check:feeds
import { getGames } from "../src/tools/athletics.js";
import { getMenus } from "../src/tools/dining.js";
import { getEvents } from "../src/tools/events.js";
import { OFFICES } from "../src/tools/offices.js";
import { campusDate } from "../src/campus-time.js";
import { USER_AGENT } from "../src/user-agent.js";

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

// Clubs: the directory should parse, with plenty of clubs in it.
try {
  const { getClubs } = await import("../src/tools/clubs.js");
  const all = await getClubs();
  const chess = await getClubs({ keyword: "chess" });
  console.log(`\nClubs: ${all.total} registered in ${all.categories.length} categories; "chess" finds ${chess.total}.`);
  if (all.total < 50) {
    problems++;
    console.log("  FAIL  far fewer clubs than expected. The feed may have changed shape.");
  }
  // A single club's own record carries the joining flags.
  const [club] = chess.clubs;
  console.log(`  "${club?.name}": joining ${club?.join ? `"${club.join.text}"` : "unknown"}; ${club?.upcoming?.length ?? "?"} upcoming events.`);
  if (!club?.join) {
    problems++;
    console.log("  FAIL  couldn't read how joining works. The club detail record may have changed shape.");
  }
  if (club && club.upcoming === null) {
    problems++;
    console.log("  FAIL  couldn't match club events. The events feed may have changed shape.");
  }
} catch (err) {
  problems++;
  console.log(`  FAIL  club feed: ${err.message}`);
}

// Hours: each calendar should answer for today, and still be looked after. A calendar nobody
// edits keeps repeating old rules (the climbing wall's said "CLOSED" in 2026 from a 2019 rule).
try {
  const { PLACES, hoursTool } = await import("../src/tools/hours.js");
  console.log("\nHours:");
  for (const place of Object.keys(PLACES)) {
    const days = JSON.parse((await hoursTool.run({ place })).content).days;
    const today = days[0].hours;
    console.log(`  ${Array.isArray(today) ? "ok  " : "--  "}  ${place}: ${JSON.stringify(today)}`);
  }
  for (const [place, { gcal }] of Object.entries(PLACES)) {
    if (!gcal) continue;
    const text = await (await fetch(`https://calendar.google.com/calendar/ical/${gcal}%40group.calendar.google.com/public/basic.ics`, { headers: { "user-agent": USER_AGENT } })).text();
    const last = [...text.matchAll(/^LAST-MODIFIED:(\d{8})/gm)].map((m) => m[1]).sort().pop() ?? "never";
    const stale = last === "never" || last < campusDate(new Date(Date.now() - 150 * 86400000)).replace(/-/g, "");
    if (stale) problems++;
    console.log(`  ${stale ? "FAIL" : "ok  "}  ${place} calendar last edited ${last}${stale ? ": nobody seems to maintain it any more; drop it from hours.js" : ""}`);
  }
} catch (err) {
  problems++;
  console.log(`  FAIL  hours: ${err.message}`);
}

// Buses: the saved timetable runs out every couple of months (feed_end_date).
{
  const { TRANSIT } = await import("../src/data/transit.js");
  const left = Math.round((new Date(`${TRANSIT.validTo}T12:00:00Z`) - Date.now()) / 86400000);
  const soon = left < 21;
  if (soon) problems++;
  console.log(`\nBus timetable: built ${TRANSIT.builtOn}, valid to ${TRANSIT.validTo} (${left} days left).`);
  if (soon) console.log("  FAIL  the timetable runs out soon. Run npm run build:transit (Tri-Valley usually has the next one out by now).");
}

// Trains and intercity buses: Amtrak reissues its timetable every week or so and changes it
// with the seasons, so a saved copy over a month old gets rebuilt.
{
  const { INTERCITY } = await import("../src/data/intercity.js");
  const { findTrips } = await import("../src/tools/intercity.js");
  const age = Math.round((Date.now() - new Date(`${INTERCITY.builtOn}T12:00:00Z`)) / 86400000);
  console.log(`\nTrains and intercity buses: saved ${INTERCITY.builtOn} (${age} days ago), ${INTERCITY.trips.length} trips.`);
  if (age > 30) {
    problems++;
    console.log("  FAIL  over a month old. Run npm run build:transit.");
  }
  const day = campusDate(new Date(Date.now() + 86400000));
  const nyc = findTrips(INTERCITY, { from: "Middlebury", to: "New York", date: day });
  const direct = nyc.trips.find((t) => t.length === 1);
  if (direct) console.log(`  ok    Middlebury to New York tomorrow: ${direct[0].route.name}, direct`);
  else {
    problems++;
    console.log("  FAIL  no direct Middlebury-New York train tomorrow. The Ethan Allen Express may have changed; check the feed.");
  }
}

// Flights: Burlington airport's board should list flights for about the next day.
try {
  const { flightsTool } = await import("../src/tools/flights.js");
  const board = JSON.parse((await flightsTool.run({})).content);
  const n = board.departure_cities_on_board.length;
  console.log(`\nBTV flight board: ${board.board_covers}, departures to ${n} cities.`);
  if (n < 3) {
    problems++;
    console.log("  FAIL  hardly any departures. The airport's flight data may have changed shape.");
  }
} catch (err) {
  problems++;
  console.log(`  FAIL  BTV flight board: ${err.message}`);
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
  const { openLocalD1 } = await import("../src/db/node-d1.js");
  const { searchPages } = await import("../src/tools/pages.js");
  const db = openLocalD1(new URL("../.cache/pages.db", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const [top] = await searchPages(db, "dining hall hours meal plan");
  db.close();
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
