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
  const cardList = (data.cards ?? []).map((c) =>
    c.type === "menu" ? `menu ${c.date} ${[...new Set(c.menus.map((m) => m.meal))].join("/")}` : c.type,
  );
  console.log(`  cards:  ${cardList.join(", ") || "none"}`);
  console.log(`  good answer: ${q.good_answer}`);
  input += data.usage?.input_tokens ?? 0;
  output += data.usage?.output_tokens ?? 0;
}
console.log(`\nTokens used: ${input} in, ${output} out. Multiply by your model's per-token price for the cost.`);
