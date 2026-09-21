# Middleburity

An unofficial, student-built assistant for Middlebury College. Ask a question, get a short answer drawn from Middlebury's own public sources, with the source's data shown underneath so you can check it.

**Status:** early build. Right now it knows the three dining halls' menus. Sports, events, and general campus questions come next (see the roadmap). It is not affiliated with Middlebury College.

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

Planned: the athletics calendar feed, the student events feed, middlebury.edu pages, and admissions pages.

Not planned without Middlebury's permission: the course catalog (its robots.txt asks that its content not be fed into AI tools) and social house parties (their registrations aren't public).

## Privacy

- The server stores nothing and doesn't log questions. It logs only the method, path, status, and timing of each request.
- To write an answer, your question is sent to Anthropic's API, and Anthropic's data policies apply to it.
- The conversation lives in the page's memory only. Reloading clears it.

## Layout

```
src/worker.js        the server (Cloudflare Worker shape): /api/today, /api/chat
src/chat.js          the question -> lookups -> answer loop
src/prompt.js        the system prompt: voice and trust rules
src/tools/           one file per source; tools/index.js lists them
public/              the page (plain HTML, CSS, JS; no build step)
dev-server.js        local stand-in for Cloudflare
tests/               unit tests, the test set, feed check, question runner
```

## Deploying

Planned for Cloudflare Workers on the free plan. It needs a Cloudflare account and a wrangler config, and neither is set up yet.

## License

MIT, © 2026 Rory Weston. See [LICENSE](LICENSE).
