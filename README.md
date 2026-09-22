# Middleburity

An unofficial, student-built assistant for Middlebury College. Ask a question, get a short answer drawn from Middlebury's own public sources, with the source's data shown underneath so you can check it.

**Status:** early build. It knows the dining hall menus, varsity schedules and results, campus events, and walking directions between campus buildings. For anything else, it says it can't check that yet and links the office that handles it. General campus questions (policies, services, admissions) come next. It is not affiliated with Middlebury College.

## How it answers

1. You ask a question.
2. The AI (Anthropic's Claude) decides which source to check.
3. The server fetches that source live, and the AI answers from what came back.
4. Under the answer, a card shows the source's own data and when it was checked, not the AI's retelling.

If no source covers a question, it says so instead of guessing.

## Run it locally

Needs Node 20 or newer.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

Put your Anthropic API key in `.dev.vars` (it's git-ignored). Then:

```bash
npm run dev
```

Open http://localhost:8787. The home screen menus work without a key; the chat needs one.

Page search needs its index, which isn't in git (it's about 17 MB and changes weekly). Build it once with the command below. The first run takes about 2 hours at the site's requested pace of one page a second; later runs only fetch changed pages:

```bash
npm run build:pages
```

## Tests

| Command | What it does | Costs money? |
|---|---|---|
| `npm test` | Unit tests. No network, no AI calls. | No |
| `npm run check:feeds` | Checks the live Middlebury sources still parse. | No |
| `npm run questions` | Asks every question in `tests/questions.json` through the running dev server so you can grade the answers. | Yes |

`tests/questions.json` is the test set. Add to it whenever you add a source or catch a bad answer.

## Sources

| Source | Used for | Last checked |
|---|---|---|
| Dining Services' public menu feed (Nutrislice) | Dining hall menus and dietary tags | 2026-09-21 |
| Middlebury Athletics' calendar feed (iCalendar) | Varsity schedules, venues, and results. Fetched at most every 2 hours, as the feed asks | 2026-09-21 |
| Presence, the campus events platform | Events posted by student organizations and offices. Online-meeting links are never shown | 2026-09-21 |
| About 3,250 student-relevant pages on middlebury.edu, including faculty profiles | Page search: how things work (hours, policies, services, costs), plus faculty research. Crawled by `npm run build:pages` at the site's requested pace of one request a second. The app searches a local index and never crawls | see `builtOn` in `src/data/pages.json` |
| OpenStreetMap (© OpenStreetMap contributors, ODbL) | Where campus buildings are, for walking-direction links. Extracted by `npm run build:places`, not fetched at runtime | map data as of 2026-05-31 |
| 18 campus office pages on middlebury.edu (and the Snow Bowl's site) | Pointing people to the right office, with a real link, when no other source answers | 2026-09-21 |

Some athletic venues (Pepin Gymnasium, the Natatorium, Chip Kenyon '85 Arena, and others) have no location that any source confirms. Directions to them say so and go to the athletics complex at 219 S. Main St. instead of guessing a spot.

`npm run check:feeds` re-checks every office link and flags any that redirect. A redirect usually means the office was renamed: the Student Activities Office's link, for one, now leads to Student Engagement and Belonging.

Planned: the athletics calendar feed, the student events feed, middlebury.edu pages, and admissions pages.

Not planned without Middlebury's permission: the course catalog (its robots.txt asks that its content not be fed into AI tools) and social house parties (their registrations aren't public).

## Privacy

- The server stores nothing and doesn't log questions. It logs only the method, path, status, and timing of each request.
- To write an answer, your question is sent to Anthropic's API, and Anthropic's data policies apply to it.
- The conversation lives in the page's memory only. Reloading clears it.
- Walking directions are a link to Google Maps. Nothing goes to Google unless you tap it.

## Layout

```
src/worker.js        the server (Cloudflare Worker shape): /api/today, /api/chat
src/chat.js          the question -> lookups -> answer loop
src/prompt.js        the system prompt: voice and trust rules
src/tools/           one file per source; tools/index.js lists them
src/data/places.js   campus building locations (generated from OpenStreetMap)
scripts/             build-places.js, which regenerates src/data/places.js
public/              the page (plain HTML, CSS, JS; no build step)
dev-server.js        local stand-in for Cloudflare
tests/               unit tests, the test set, feed check, question runner
```

## Deploying

Planned for Cloudflare Workers on the free plan. It needs a Cloudflare account and a wrangler config, and neither is set up yet.

## License

MIT, © 2026 Rory Weston. See [LICENSE](LICENSE).
