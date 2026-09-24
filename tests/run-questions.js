// Asks every test-set question through the running dev server and prints the answers
// for you to grade against good_answer. This makes real AI calls, so it costs money.
//   npm run dev          (in one terminal)
//   npm run questions    (in another; add an id to run just one: npm run questions -- vegan-ross)
import { readFile } from "node:fs/promises";

const base = process.env.BASE_URL || "http://localhost:8787";
const only = process.argv[2];
const { questions } = JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8"));
const picked = questions.filter((q) => !only || q.id === only);

let input = 0;
let output = 0;
for (const q of picked) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: q.question }] }),
  });
  const data = await res.json();
  console.log(`\n[${q.id}] (${q.when}) ${q.question}`);
  if (!res.ok) {
    console.log(`  ERROR ${res.status}: ${data.error}`);
    continue;
  }
  console.log(`  answer: ${data.answer}`);
  const cardList = (data.cards ?? []).map((c) => {
    if (c.type === "menu") return `menu ${c.date} ${[...new Set(c.menus.map((m) => m.meal))].join("/")}`;
    if (c.type === "games") return `games(${c.games.length}${c.games[0] ? `: first ${c.games[0].sport} ${c.games[0].start}` : ""})`;
    if (c.type === "events") return `events(${c.events.length} of ${c.total})`;
    if (c.type === "directions") return `directions(${c.from ?? "here"} -> ${c.to}${c.note ? ", no exact spot" : ""})`;
    if (c.type === "office") return `office(${c.name})`;
    if (c.type === "pages") return `pages(${c.pages.length}: ${c.pages.slice(0, 3).map((p) => p.title).join(" | ")})`;
    if (c.type === "clubs") return `clubs(${c.clubs.map((x) => x.name).slice(0, 4).join(" | ")})`;
    if (c.type === "hours") return `hours(${c.place}: ${c.days.map((d) => `${d.date} ${d.hours.join("/") || "none"}`).join("; ")})`;
    if (c.type === "weather") return `weather(${c.place}${c.alerts.length ? `, alerts: ${c.alerts.map((a) => a.event).join("/")}` : ""}: ${c.periods.slice(0, 2).map((p) => `${p.name} ${p.temperature} ${p.summary}`).join("; ")})`;
    if (c.type === "bus") return `bus(${c.date}: ${c.departures.slice(0, 3).map((d) => `${d.time} ${d.route} ${d.stop}`).join("; ")})`;
    if (c.type === "trips") return `trips(${c.from}->${c.to} ${c.date}: ${c.trips.map((t) => t.map((l) => `${l.route} ${l.leaves}-${l.arrives}`).join(" + ")).join("; ")})`;
    if (c.type === "flights") return `flights(${c.flights.length}: ${c.flights.slice(0, 3).map((f) => `${f.city} ${f.scheduled}`).join("; ")})`;
    return c.type;
  });
  console.log(`  cards:  ${cardList.join(", ") || "none"}`);
  console.log(`  good answer: ${q.good_answer}`);
  input += data.usage?.input_tokens ?? 0;
  output += data.usage?.output_tokens ?? 0;
}
console.log(`\nTokens used: ${input} in, ${output} out. Multiply by your model's per-token price for the cost.`);
