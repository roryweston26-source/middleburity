// The whole server. It's written as a Cloudflare Worker (web-standard Request/Response),
// so the same file runs locally under dev-server.js and in production on Cloudflare.
// Privacy: nothing here logs or stores what people ask.
import Anthropic from "@anthropic-ai/sdk";
import { ChatInputError, answerQuestion } from "./chat.js";
import { nextHomeGames } from "./tools/athletics.js";
import { todaysMenus } from "./tools/dining.js";
import { todaysEvents } from "./tools/events.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleChat(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "The chat isn't connected yet: the server has no Anthropic API key." }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send the question as JSON." }, 400);
  }
  try {
    return json(await answerQuestion(body?.messages, { env }));
  } catch (err) {
    if (err instanceof ChatInputError) return json({ error: err.message }, 400);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "The server's API key was rejected." }, 503);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Too many questions at once. Try again in a minute." }, 429);
    if (err instanceof Anthropic.APIError) {
      console.error(`AI service error ${err.status}: ${err.message}`);
      return json({ error: "The AI service had a problem. Try again in a moment." }, 502);
    }
    console.error(`chat failed: ${err?.name}: ${err?.message}`);
    return json({ error: "Something broke on our end." }, 500);
  }
}

export default {
  async fetch(request, env = {}) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/today") {
      if (request.method !== "GET") return json({ error: "Use GET." }, 405);
      // Each card loads on its own: one feed being down shouldn't blank the others.
      const [dining, games, events] = await Promise.allSettled([todaysMenus(), nextHomeGames(), todaysEvents()]);
      const value = (r) => (r.status === "fulfilled" ? r.value : null);
      return json({ dining: value(dining), games: value(games), events: value(events) });
    }

    if (pathname === "/api/chat") {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      return handleChat(request, env);
    }

    if (pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);

    // In production Cloudflare serves public/ itself; locally dev-server.js does.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
