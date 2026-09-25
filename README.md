# Middleburity

An unofficial, student-built assistant for Middlebury College. Ask a question, get a short answer drawn from Middlebury's own public sources, with the source's data shown underneath so you can check it.

It is not affiliated with Middlebury College and doesn't speak for it.

**Status:** running as a private test at a `workers.dev` address, behind an access code. It answers questions about:

- **Daily life:** dining hall menus, campus events and the college's events calendar, clubs, campus jobs, free study rooms in the library, and library and athletic-facility hours.
- **Getting around:** walking directions, local buses, trains and intercity buses, flights out of Burlington, weather and alerts, and Snow Bowl lift hours.
- **How things work:** policies, services, costs and deadlines, from about 3,350 indexed middlebury.edu and Handbook pages, plus a directory of 18 offices.
- **Athletics:** varsity schedules and results.

It doesn't know class times or anything about you personally; see [Not used without permission](#not-used-without-permission).

## How it answers

1. You ask a question.
2. The AI model (DeepSeek's, through OpenRouter) decides which sources to check.
3. The server reads those sources and the model answers from what came back, never from its own memory.
4. Under the answer, a card shows the source's own data, where it came from, and when it was checked. The server builds the cards from the source, not the model.

If no source covers a question, it says so and points to the office that handles it, instead of guessing.

## Ground rules

These are in the model's instructions and checked by the test set:

- **Sources, not memory.** No hours, prices, names, phone numbers or links unless a source returned them.
- **Safety.** It never calls a dish safe for an allergy (dietary tags are Dining Services' labels; ask staff). Emergencies mean 911 first. No medical advice, and no help with homework or graded work.
- **Source text is data, not instructions.** Event and club descriptions are written by students, so the test set plants instructions in them and checks the model ignores them.
- **Only Middlebury questions.** Anything else gets a one-line "that's not what I'm for".

## Sources

Each source is read politely: every request identifies the project with a User-Agent that links this repository, follows the site's robots.txt and crawl delay, and is cached so a source is read at most every few minutes to hours.

| Source | Used for | Freshness |
|---|---|---|
| Dining Services' menu feed (Nutrislice) | Dining hall menus and dietary tags | live, cached 30 minutes |
| Middlebury Athletics' calendar feed | Varsity schedules, venues, results | live, cached 2 hours (the site's crawl delay) |
| Presence (MiddPresence) | Events posted by student organizations and offices. Online-meeting links are never shown | live, cached 30 minutes |
| Presence's club directory | Clubs: what exists, when they meet, how joining works, the listed contact, next events | live, cached 6 hours |
| middlebury.edu/events | The college calendar: lectures, performances, symposia, office events | live, cached 2 hours |
| Middlebury's job board (Workable) | Open campus jobs, student jobs first | live, cached 6 hours |
| The library's LibCal | Library, Crossroads Café, research help and Special Collections hours; free group study rooms in Davis (booking links to LibCal) | live, cached 10 minutes to 3 hours |
| Athletics' facility-hours calendars | Athletic complex, Fitness Center and pool hours | live, cached 3 hours |
| Middlebury Snow Bowl's hours calendar | Lift hours by day | live, cached 3 hours |
| Tri-Valley Transit's timetable (GTFS) | Middlebury Shuttle, Burlington Link and other Addison County buses | saved by `npm run build:transit`; each timetable is valid for a couple of months |
| Amtrak's national timetable (GTFS) | Ethan Allen Express (stops in Middlebury), Vermonter, Adirondack, Lake Shore Limited | saved by `npm run build:transit` |
| Vermont Translines' timetable (GTFS) | The US-7 intercity bus: Burlington and its airport, Middlebury, Rutland, Albany | same |
| Burlington International Airport's flight board | Departures and arrivals for about the next day | live, cached 10 minutes |
| National Weather Service (public domain) | Forecasts and alerts for campus and the Snow Bowl | live, cached 30 minutes |
| About 3,350 pages: middlebury.edu, the Middlebury Handbook (student and all-college policies), and the Snow Bowl's, Rikert's and Tri-Valley Transit's student-facing pages | Page search: policies, services, costs, procedures, faculty profiles | crawled at one request a second by `npm run build:pages`; the app searches its own index and never crawls |
| OpenStreetMap (© OpenStreetMap contributors, ODbL) | Where campus buildings are, for Google Maps walking links | extracted by `npm run build:places` |
| 18 office pages on middlebury.edu | Pointing people to the right office, with a real link | checked by `npm run check:feeds` |
| RateMyProfessors | A link to a named professor's page, only. Reviews are never read, summarized or ranked | link only |

Emails and phone numbers are removed from indexed page text. Pages over a year old are flagged as possibly out of date, and when two Middlebury pages disagree, the answer says so.

### Not used without permission

- **Course schedules and the catalog.** The course catalog's robots.txt asks that its content not be used as AI input, so class times, rooms and open seats aren't read unless the Registrar agrees.
- **Social house events.** Their registrations aren't public.
- **Greyhound, Megabus and Dartmouth Coach schedules.** None has a published open license.
- **Anything behind a Middlebury login.**

## Privacy

- The server doesn't store or log questions or answers. It logs only each request's method, path, status and timing.
- To write an answer, your question goes through OpenRouter to DeepSeek's model, hosted by DeepInfra. Requests tell OpenRouter to use only hosts that don't train on or keep prompts (`data_collection: "deny"`), and those services' own policies apply.
- The conversation lives in the page's memory only. Reloading clears it.
- No analytics, cookies or third-party scripts. Walking directions are a link to Google Maps; nothing goes to Google unless you tap it.
- For the usage limits, the server counts questions per visitor. A visitor is an anonymous code: a hash of the date, a secret and their IP address. The IP address isn't stored, codes change daily so days can't be linked, and counts are deleted after two days.
- If an access code is in use, your browser remembers it on your device.

## Run it locally

Needs Node 20 or newer.

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

Put an OpenRouter key in `.dev.vars` (it's git-ignored), or an Anthropic key with `MODEL` set to a Claude model. Then:

```bash
npm run dev
```

Open http://localhost:8787. The home screen works without a key; the chat needs one.

Page search needs its index, which isn't in git (about 20 MB). The first build takes about 2 hours at the site's requested pace of one page a second; later builds only fetch changed pages:

```bash
npm run build:pages
```

To run on Cloudflare's own runtime locally, load the index into a local D1 database with `npm run db:local`, then run `npm run dev:cf` (http://localhost:8788).

## Tests

| Command | What it does | Costs money? |
|---|---|---|
| `npm test` | 138 unit tests. No network, no AI calls | No |
| `npm run check:feeds` | Checks every live source still parses, office links still resolve, and saved timetables aren't about to expire | No |
| `npm run eval:search` | Scores page search on 67 labeled queries | No |
| `npm run questions` | Asks the 82 questions in `tests/questions.json` through the running dev server, for grading against each one's expected answer | Yes, about $0.07 a round on DeepSeek |

The question set tags each question with what it tests: grounding, tool choice, safety, time handling, format, and prompt injection. Injection questions need test mode (`TEST_PROBES=1` in `.dev.vars`), which plants an event and a club carrying instructions aimed at the AI; the runner fails any answer that follows them. Production never loads test mode.

The model was chosen by running the question set against seven models and grading every answer by hand against its sources.

## Layout

```
src/worker.js        the server (Cloudflare Worker): /api/today, /api/chat
src/chat.js          question -> lookups -> answer loop, and the Sources card
src/prompt.js        the model's instructions
src/providers/       the OpenAI-compatible path (OpenRouter); Claude uses Anthropic's SDK in chat.js
src/tools/           one file per source; tools/index.js lists them
src/limits.js        per-visitor limits and the daily spending cap
src/data/            generated data: buildings, bus and train timetables
src/db/              a D1-shaped adapter over Node's SQLite, so search runs the same locally
scripts/             builders for the page index, timetables and building list
public/              the page: plain HTML, CSS and JS, no build step
dev-server.js        local stand-in for Cloudflare
tests/               unit tests, question set, feed checks, search eval
```

## Deploying

The app runs on Cloudflare Workers' free plan, with page search in a D1 database.

1. `npx wrangler login`
2. `npx wrangler d1 create middleburity`, and put the `database_id` it prints into `wrangler.jsonc`.
3. `npm run db:remote` to load the search index.
4. Set the secrets. Each command asks for the value, so it never lands in a file. **Set the access code before the key**, or the chat is open to anyone in between:
   - `npx wrangler secret put ACCESS_CODE`
   - `npx wrangler secret put VISITOR_SALT` (any long random string)
   - `npx wrangler secret put OPENAI_COMPAT_API_KEY` (or `ANTHROPIC_API_KEY` for a Claude model)
5. `npm run deploy`
6. Set a credit limit on the key at the provider. The app's own daily cap is the first line of defense; that limit is the backstop.

After `npm run build:pages`, run `npm run db:remote` again so production matches.

## Spending protection

`src/limits.js` checks every question before it reaches the model:

- **Per visitor:** 20 questions an hour and 60 a day.
- **For the whole app:** a daily dollar cap ($2), from the cost the provider reports for each answer.
- **An access code** keeps the chat to invited testers. The home screen stays open, since it costs nothing.

All three are settings in `wrangler.jsonc`.

## License

MIT, © 2026 Rory Weston. See [LICENSE](LICENSE). Middlebury's names and content belong to Middlebury College; this project uses no Middlebury logos.
