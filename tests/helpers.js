import { readFileSync } from "node:fs";

export const fixture = JSON.parse(readFileSync(new URL("./fixtures/proctor-dinner-week.json", import.meta.url), "utf8"));

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
