// Local stand-in for Cloudflare: serves public/ and hands /api/* to src/worker.js.
// Secrets come from .dev.vars (the same file Cloudflare's wrangler reads), never from git.
// Logs method, path, status and time only; never request bodies.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./src/worker.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT) || 8787;

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
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
  return response.status;
}

const env = await loadEnv();
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
  console.log(`Middleburity running at http://localhost:${port}`);
  console.log(env.ANTHROPIC_API_KEY ? "Chat: connected (key found in .dev.vars)" : "Chat: no API key yet (add one to .dev.vars)");
});
