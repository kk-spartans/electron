// Bun server used by the Docker image.
//
// Serves the statically exported site from `out/`.
//
// Configuration (env vars):
//   SERVE_DIR directory to serve (default: out/)
//   PORT      listening port (default: 8080)

import { serve } from "bun";

const root = process.env.SERVE_DIR ?? "out/";
const port = Number(process.env.PORT ?? 8080);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function contentType(pathname: string) {
  const match = pathname.match(/\.[a-z0-9]+$/i);
  if (!match) return "application/octet-stream";
  return contentTypes[match[0].toLowerCase()] ?? "application/octet-stream";
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function serveStatic(pathname: string) {
  const safePath = pathname.split("?")[0].split("#")[0].replace(/\/+/g, "/");
  const relative = safePath === "/" ? "index.html" : safePath.replace(/^\//, "");
  const candidate = `${root}/${relative}`;
  if (!candidate.startsWith(root)) return htmlResponse("Not found", 404);
  let file = Bun.file(candidate);
  if (!(await file.exists()) && safePath.startsWith("/")) {
    file = Bun.file(`${root}/404.html`);
  }
  if (!(await file.exists())) return htmlResponse("Not found", 404);
  return new Response(file, { headers: { "Content-Type": contentType(candidate) } });
}

const server = serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);
    try {
      return await serveStatic(url.pathname);
    } catch (error) {
      return htmlResponse(error instanceof Error ? error.message : "Internal server error.", 500);
    }
  },
});

console.log(`Electron server listening on http://0.0.0.0:${server.port}`);
console.log(`Serving static site from ${root}`);
