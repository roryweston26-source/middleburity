// Checks the live sources still look the way the code expects. Free to run (no AI calls).
// Run it when something looks off, and before any demo: npm run check:feeds
import { getMenus } from "../src/tools/dining.js";

const result = await getMenus();
let problems = 0;
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
  console.log("No hall has a parsed menu today. Either everything is closed or the feed changed shape.");
  problems++;
}
process.exitCode = problems ? 1 : 0;
