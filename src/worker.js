// The whole server. It's written as a Cloudflare Worker (web-standard Request/Response),
// so the same file runs locally under dev-server.js and in production on Cloudflare.
// Privacy: nothing here logs or stores what people ask. The only thing stored per visitor
// is an anonymous daily count, for the limits in limits.js.
import Anthropic from "@anthropic-ai/sdk";
import { campusDate } from "./campus-time.js";
import { ChatInputError, answerQuestion } from "./chat.js";
import { ProviderError } from "./providers/openai-compatible.js";
import { admit, limitsFrom, recordSpend, visitorId } from "./limits.js";
import { estimateUsd } from "./pricing.js";
import { nextHomeGames } from "./tools/athletics.js";
import { todaysMenus } from "./tools/dining.js";
import { todaysEvents } from "./tools/events.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Compares in constant time, so the access code can't be guessed a character at a time.
function sameText(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function handleChat(request, env) {
  // A non-Claude model under test needs its own provider key instead (checked when it's called).
  if (!env.ANTHROPIC_API_KEY && (env.MODEL ?? "claude-").startsWith("claude-")) {
    return json({ error: "The chat isn't connected yet: the server has no Anthropic API key." }, 503);
  }
  // A friends-only test: when ACCESS_CODE is set, the chat needs it. Menus and the home
  // screen stay open, since they cost nothing.
  if (env.ACCESS_CODE && !sameText(request.headers.get("x-access-code") ?? "", env.ACCESS_CODE)) {
    return json({ error: "This is a friends-only test. Enter the access code to ask questions.", needsCode: true }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send the question as JSON." }, 400);
  }

  const now = new Date();
  let remainingToday = null;
  if (env.DB) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const visitor = await visitorId(ip, campusDate(now), env.VISITOR_SALT ?? "local-dev");
    const gate = await admit(env.DB, { visitor, limits: limitsFrom(env), now });
    if (!gate.ok) return json({ error: gate.error }, gate.status);
    remainingToday = gate.remainingToday;
  } else {
    console.warn("No database: usage limits and the spending cap are off.");
  }

  try {
    const result = await answerQuestion(body?.messages, { env });
    if (env.DB) await recordSpend(env.DB, estimateUsd(result.model, result.usage), now);
    return json({ ...result, ...(remainingToday !== null && { remainingToday }) });
  } catch (err) {
    if (err instanceof ChatInputError) return json({ error: err.message }, 400);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "The server's API key was rejected." }, 503);
    if (err instanceof Anthropic.RateLimitError) return json({ error: "Too many questions at once. Try again in a minute." }, 429);
    if (err instanceof Anthropic.APIError) {
      console.error(`AI service error ${err.status}: ${err.message}`);
      return json({ error: "The AI service had a problem. Try again in a moment." }, 502);
    }
    // A non-Claude model under comparison testing (src/providers/openai-compatible.js).
    if (err instanceof ProviderError) {
      console.error(`model provider error ${err.status}: ${err.message}`);
      if (err.status === 401 || err.status === 403) return json({ error: "The model provider rejected the server's key." }, 503);
      if (err.status === 429) return json({ error: "Too many questions at once. Try again in a minute." }, 429);
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
