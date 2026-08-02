// Bun API server used by the Docker image.
//
// Serves the statically exported site from `out/` and provides the
// `/api/reactions` endpoint, which sends the selected species to an
// OpenAI-compatible model and returns every plausible balanced reaction.
//
// Configuration (env vars):
//   SERVE_DIR          directory to serve (default: out/)
//   PORT               listening port (default: 8080)
//   OPENAI_BASE_URL    base URL for chat completions (default: https://api.openai.com/v1)
//   OPENAI_API_KEY     API key for the model provider
//   OPENAI_MODEL       model to use (default: gpt-4o-mini)
//   REACTION_CACHE_DIR directory for persisted AI reaction responses (default: .cache/ai-reactions)
//   REACTION_CACHE_MAX in-memory cache entry cap before reset (default: 10000)

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { serve } from "bun";

const root = process.env.SERVE_DIR ?? "out/";
const port = Number(process.env.PORT ?? 8080);
const openaiBaseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);
const openaiApiKey = process.env.OPENAI_API_KEY ?? "";
const openaiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const reactionCacheDir = process.env.REACTION_CACHE_DIR ?? ".cache/ai-reactions";
const reactionCacheMax = Number(process.env.REACTION_CACHE_MAX ?? 10_000);

const reactionCache = new Map<string, unknown>();
const inFlight = new Map<string, Promise<unknown>>();

function reactionCacheKey(input: ReactionInput) {
  const reactants = input.reactants
    .map((species) => species.formula)
    .sort()
    .join("+");
  const products = input.products
    .map((species) => species.formula)
    .sort()
    .join("+");
  return createHash("sha256").update(`${reactants}->${products}`).digest("hex");
}

async function readReactionCache(key: string) {
  const hit = reactionCache.get(key);
  if (hit) return hit;
  try {
    const file = Bun.file(`${reactionCacheDir}/${key}.json`);
    if (!(await file.exists())) return undefined;
    const parsed = await file.json();
    reactionCache.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeReactionCache(key: string, value: unknown) {
  if (reactionCache.size >= reactionCacheMax) reactionCache.clear();
  reactionCache.set(key, value);
  try {
    await mkdir(reactionCacheDir, { recursive: true });
    await Bun.write(`${reactionCacheDir}/${key}.json`, JSON.stringify(value));
  } catch {
    // The cache is best-effort; failures must not break requests.
  }
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".json.gz": "application/gzip",
  ".gz": "application/gzip",
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
  const match = pathname.match(/\.[a-z0-9]+(\.gz)?$/i);
  if (!match) return "application/octet-stream";
  return contentTypes[match[0].toLowerCase()] ?? "application/octet-stream";
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
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

type Species = { formula: string; name?: string; coefficient?: number };

type ReactionInput = {
  reactants: Species[];
  products: Species[];
};

type AIReaction = {
  name?: string;
  condition?: string;
  reactants: Species[];
  products: Species[];
};

function sanitizeSpecies(value: unknown): Species[] {
  if (!Array.isArray(value)) return [];
  const species: Species[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const formula = (item as Species).formula;
    if (typeof formula !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(formula)) continue;
    const name = (item as Species).name;
    const rawCoefficient = (item as Species & { coefficient?: unknown }).coefficient;
    const coefficient =
      typeof rawCoefficient === "number" && Number.isFinite(rawCoefficient) && rawCoefficient > 0
        ? rawCoefficient
        : undefined;
    species.push({
      formula,
      ...(typeof name === "string" && name ? { name } : {}),
      ...(coefficient ? { coefficient } : {}),
    });
  }
  return species;
}

function sanitizeReactions(value: unknown): AIReaction[] {
  if (!Array.isArray(value)) return [];
  const reactions: AIReaction[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const reactants = sanitizeSpecies((item as AIReaction).reactants);
    const products = sanitizeSpecies((item as AIReaction).products);
    if (!reactants.length || !products.length) continue;
    const name = (item as AIReaction).name;
    const condition = (item as AIReaction).condition;
    reactions.push({
      ...(typeof name === "string" && name ? { name } : {}),
      ...(typeof condition === "string" && condition ? { condition } : {}),
      reactants,
      products,
    });
  }
  return reactions;
}

const systemPrompt = `You are a chemistry engine that enumerates balanced chemical reactions.
You will be given chemical species: the reactants selected on a canvas, and any known products from a reaction database.
Enumerate every chemically plausible reaction:
- Each reaction must use a non-empty subset of the given reactant species; never invent new reactants.
- Products may be any reasonable chemical species; prefer the known products when provided.
- Provide each reaction as ONE fully balanced equation with the smallest integer coefficients.
- The "different ways to balance" requirement means: include every distinct product set that can be formed from the reactants, and every independent reaction that shares those species.
- Every equation must conserve element counts exactly.
- Formulas use standard chemical notation with element symbols and subscripts (e.g. H2O, CsI, CO2).
Return ONLY strict JSON matching this schema, with no commentary:
{"reactions":[{"name":"short human name","condition":"brief conditions if known","reactants":[{"formula":"A","coefficient":1}],"products":[{"formula":"B","coefficient":1}]}]}`;

function buildPrompt(input: ReactionInput) {
  const species = [
    ...input.reactants.map(
      (reactant) => `reactant: ${reactant.formula}${reactant.name ? ` (${reactant.name})` : ""}`,
    ),
    ...input.products.map(
      (product) => `known product: ${product.formula}${product.name ? ` (${product.name})` : ""}`,
    ),
  ];
  return {
    model: openaiModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Species:\n${species.join("\n")}` },
    ],
  };
}

async function chatCompletions(body: unknown, allowUnstructured = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (
      allowUnstructured &&
      (response.status === 400 || response.status === 422) &&
      typeof body === "object" &&
      body !== null &&
      "response_format" in body
    ) {
      const { response_format: _dropped, ...retryBody } = body as Record<string, unknown> & {
        response_format?: unknown;
      };
      return chatCompletions(retryBody, false);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `model provider returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    return (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleReactions(request: Request) {
  if (!openaiApiKey) {
    return jsonResponse({ error: "OPENAI_API_KEY is not configured." }, 503);
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be JSON." }, 400);
  }
  const input: ReactionInput = {
    reactants: sanitizeSpecies((raw as ReactionInput)?.reactants),
    products: sanitizeSpecies((raw as ReactionInput)?.products),
  };
  if (!input.reactants.length) {
    return jsonResponse({ error: "Provide at least one reactant." }, 400);
  }
  const cacheKey = reactionCacheKey(input);
  const cached = await readReactionCache(cacheKey);
  if (cached) return jsonResponse(cached);
  const pending = inFlight.get(cacheKey);
  if (pending) return jsonResponse(await pending);
  const compute = (async () => {
    let payload: { choices?: Array<{ message?: { content?: string } }> };
    try {
      payload = await chatCompletions(buildPrompt(input));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "The model could not be reached.");
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("The model returned an empty response.");
    let parsed: { reactions?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("The model returned invalid JSON.");
    }
    const reactions = sanitizeReactions(parsed.reactions);
    if (!reactions.length) throw new Error("The model returned no reactions.");
    return { source: "ai", model: openaiModel, reactions };
  })();
  inFlight.set(cacheKey, compute);
  try {
    const body = await compute;
    await writeReactionCache(cacheKey, body);
    return jsonResponse(body);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "The model could not be reached." },
      502,
    );
  } finally {
    inFlight.delete(cacheKey);
  }
}

function handleHealth() {
  return jsonResponse({
    ok: true,
    service: "electron-reaction-api",
    model: openaiModel,
    aiConfigured: Boolean(openaiApiKey),
    cacheSize: reactionCache.size,
  });
}

const server = serve({
  port,
  hostname: "0.0.0.0",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/reactions") {
      if (request.method === "GET") return handleHealth();
      if (request.method === "POST") return handleReactions(request);
      return jsonResponse({ error: "Method not allowed." }, 405);
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "Not found." }, 404);
    }
    return serveStatic(url.pathname);
  },
});

console.log(`Electron API server listening on http://0.0.0.0:${server.port}`);
console.log(`Serving static site from ${root}`);
console.log(`Reaction model: ${openaiModel} (${openaiApiKey ? "configured" : "NOT configured"})`);
