import { readFileSync } from "node:fs";

export const fixture = JSON.parse(readFileSync(new URL("./fixtures/proctor-dinner-week.json", import.meta.url), "utf8"));

export const athleticsIcs = readFileSync(new URL("./fixtures/athletics.ics", import.meta.url), "utf8");
export const eventsFixture = JSON.parse(readFileSync(new URL("./fixtures/events.json", import.meta.url), "utf8"));

// Answers fetch() by URL: the first route whose key appears in the URL wins.
export function stubFetch(t, routes) {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return new Response("not stubbed", { status: 599 });
    const { status = 200, body } = routes[key];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return requested;
}

// Stands in for the Nutrislice feed: every hall and meal gets the same saved week.
// Returns the list of URLs requested so tests can check what was asked for.
export function stubMenuFeed(t, { status = 200, body = fixture } = {}) {
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return requested;
}
