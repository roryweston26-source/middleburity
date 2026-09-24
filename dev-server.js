// Local stand-in for Cloudflare: serves public/ and hands /api/* to src/worker.js.
// Secrets come from .dev.vars (the same file Cloudflare's wrangler reads), never from git.
// Logs method, path, status and time only; never request bodies.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openLocalD1 } from "./src/db/node-d1.js";
import worker from "./src/worker.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
// Flags for comparing models side by side, one server per model:
//   node dev-server.js --port=8791 --model=openai/gpt-6-luna [--provider=DeepInfra]
// They override .dev.vars (PORT, MODEL, OPENROUTER_PROVIDER); secrets still come from the file.
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const port = Number(flag("port") ?? process.env.PORT) || 8787;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function loadEnv() {
  const env = {};
  try {
    const text = await readFile(join(root, ".dev.vars"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .dev.vars yet: the menus still work, the chat reports that it has no key.
  }
  return env;
}

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403).end();
    return 403;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
    return 200;
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return 404;
  }
}

async function handle(req, res, env) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname, res);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(url, {
    method: req.method,
    // Cloudflare tells the Worker who is asking with this header; locally it's the socket address.
    headers: { ...req.headers, "cf-connecting-ip": req.socket.remoteAddress ?? "local" },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  return response.status;
}

const env = await loadEnv();
if (flag("model")) env.MODEL = flag("model");
if (flag("provider")) env.OPENROUTER_PROVIDER = flag("provider");
// Test mode for the question set: plants an event and a club carrying instructions aimed at
// the AI (tests/probes.js), to check the model ignores them. Local only; never in production.
if (env.TEST_PROBES === "1") {
  const { installProbes } = await import("./tests/probes.js");
  installProbes();
}
// The local stand-in for Cloudflare D1: page search plus the usage counters.
const dbPath = join(root, ".cache", "pages.db");
if (existsSync(dbPath)) env.DB = openLocalD1(dbPath);
createServer(async (req, res) => {
  const started = Date.now();
  let status = 500;
  try {
    status = await handle(req, res, env);
  } catch (err) {
    console.error(`dev server error: ${err.message}`);
    if (!res.headersSent) res.writeHead(500).end();
  }
  console.log(`${req.method} ${req.url.split("?")[0]} ${status} ${Date.now() - started}ms`);
}).listen(port, () => {
  console.log(`Middleburity running at http://localhost:${port}${env.MODEL ? ` (model ${env.MODEL})` : ""}`);
  console.log(env.ANTHROPIC_API_KEY ? "Chat: connected (key found in .dev.vars)" : "Chat: no API key yet (add one to .dev.vars)");
  console.log(env.DB ? "Page search: ready (.cache/pages.db)" : "Page search: not built yet (npm run build:pages)");
  console.log(env.ACCESS_CODE ? "Access code: required for the chat" : "Access code: none set (chat is open locally)");
  if (env.TEST_PROBES === "1") console.log("TEST MODE: planted test event and club are in the Presence feeds (tests/probes.js)");
});
