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
//   SEARXNG_BASE_URL   internal SearXNG URL for optional model web searches (default: http://localhost:8080)
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
const searxngBaseUrl = (process.env.SEARXNG_BASE_URL ?? "http://localhost:8080").replace(
  /\/+$/,
  "",
);
const reactionCacheDir = process.env.REACTION_CACHE_DIR ?? ".cache/ai-reactions";
const reactionCacheMax = Number(process.env.REACTION_CACHE_MAX ?? 10_000);

const reactionCache = new Map<string, unknown>();
const inFlight = new Map<string, Promise<unknown>>();

type StructuredOutputSupport = "supported" | "unsupported" | "unknown";

let structuredOutputSupport: StructuredOutputSupport = "unknown";

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
- Diatomic elements appear as H2, N2, O2, F2, Cl2, Br2, I2.
Return ONLY strict JSON matching this schema, with no commentary:
{"reactions":[{"name":"short human name","condition":"brief conditions if known","reactants":[{"formula":"A","coefficient":1}],"products":[{"formula":"B","coefficient":1}]}]}`;

const reactionSchema = {
  type: "object",
  required: ["reactions"],
  additionalProperties: false,
  properties: {
    reactions: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "condition", "reactants", "products"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          condition: { type: "string" },
          reactants: {
            type: "array",
            items: {
              type: "object",
              required: ["formula", "name", "coefficient"],
              additionalProperties: false,
              properties: {
                formula: { type: "string" },
                name: { type: "string" },
                coefficient: { type: "integer" },
              },
            },
          },
          products: {
            type: "array",
            items: {
              type: "object",
              required: ["formula", "name", "coefficient"],
              additionalProperties: false,
              properties: {
                formula: { type: "string" },
                name: { type: "string" },
                coefficient: { type: "integer" },
              },
            },
          },
        },
      },
    },
  },
};

const structureSelectionSchema = {
  type: "object",
  required: ["cid"],
  additionalProperties: false,
  properties: {
    cid: { type: "integer" },
  },
};

type StructureCandidate = { cid: number; name: string; formula: string };

const webSearchTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current or obscure chemistry information when it would improve the answer.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The search query" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function buildPrompt(input: ReactionInput, useStructuredOutput: boolean) {
  const species = [
    ...input.reactants.map(
      (reactant) => `reactant: ${reactant.formula}${reactant.name ? ` (${reactant.name})` : ""}`,
    ),
    ...input.products.map(
      (product) => `known product: ${product.formula}${product.name ? ` (${product.name})` : ""}`,
    ),
  ];
  const body = {
    model: openaiModel,
    temperature: 0.2,
    tools: [webSearchTool],
    messages: [
      {
        role: "system",
        content: `${systemPrompt}\nYou may call the web_search tool when current or obscure information would help. Use its returned contents as evidence, but still return only the requested JSON.`,
      },
      { role: "user", content: `Species:\n${species.join("\n")}` },
    ],
  };
  return useStructuredOutput
    ? {
        ...body,
        response_format: {
          type: "json_schema",
          json_schema: { name: "reactions", strict: true, schema: reactionSchema },
        },
      }
    : body;
}

function buildStructureSelectionPrompt(
  input: {
    formula: string;
    candidates: StructureCandidate[];
    reactants: Species[];
    reactionName?: string;
    condition?: string;
  },
  useStructuredOutput: boolean,
) {
  const candidates = input.candidates
    .map((candidate) => `CID ${candidate.cid}: ${candidate.name} [${candidate.formula}]`)
    .join("\n");
  const reactants = input.reactants
    .map((reactant) => `${reactant.formula}${reactant.name ? ` (${reactant.name})` : ""}`)
    .join(" + ");
  const body = {
    model: openaiModel,
    temperature: 0,
    tools: [webSearchTool],
    messages: [
      {
        role: "system",
        content:
          "You resolve an ambiguous chemical formula to one PubChem candidate. Choose exactly one CID from the supplied candidate list. Use the candidate name, formula, reaction context, and web_search when useful; do not choose by list position and never invent a CID. Return only JSON with the selected CID.",
      },
      {
        role: "user",
        content: [
          `Formula to resolve: ${input.formula}`,
          `Reactants: ${reactants || "unknown"}`,
          input.reactionName ? `Proposed reaction: ${input.reactionName}` : "",
          input.condition ? `Conditions: ${input.condition}` : "",
          "PubChem candidates:",
          candidates,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  };
  return useStructuredOutput
    ? {
        ...body,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "structure_selection",
            strict: true,
            schema: structureSelectionSchema,
          },
        },
      }
    : body;
}

function logOpenAIRequest(body: unknown) {
  console.log(
    `[openai] request ${JSON.stringify({
      method: "POST",
      url: `${openaiBaseUrl}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: openaiApiKey ? "Bearer [redacted]" : "Bearer [not configured]",
      },
      body,
    })}`,
  );
}

function logOpenAIResponse(
  response: { status: number; statusText: string; headers: Headers },
  body: string,
) {
  console.log(
    `[openai] response ${JSON.stringify({
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    })}`,
  );
}

async function openAIRequest(body: unknown, timeoutMs = 300_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  logOpenAIRequest(body);
  try {
    const response = await fetch(`${openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(openaiApiKey ? { Authorization: `Bearer ${openaiApiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawBody = await response.text();
    logOpenAIResponse(response, rawBody);
    return { response, rawBody };
  } catch (error) {
    console.error(
      `[openai] request failed ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function providerError(status: number, rawBody: string) {
  return new Error(
    `model provider returned ${status}${rawBody ? `: ${rawBody.slice(0, 300)}` : ""}`,
  );
}

async function chatCompletions(body: unknown, allowUnstructured = true) {
  const { response, rawBody } = await openAIRequest(body);
  if (
    allowUnstructured &&
    (response.status === 400 || response.status === 422) &&
    typeof body === "object" &&
    body !== null &&
    "response_format" in body
  ) {
    structuredOutputSupport = "unsupported";
    const { response_format: _dropped, ...retryBody } = body as Record<string, unknown> & {
      response_format?: unknown;
    };
    return chatCompletions(retryBody, false);
  }
  if (!response.ok) throw providerError(response.status, rawBody);
  return JSON.parse(rawBody) as ChatPayload;
}

const structuredOutputProbeBody = {
  model: openaiModel,
  temperature: 0,
  max_tokens: 16,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "structured_output_probe",
      strict: true,
      schema: {
        type: "object",
        properties: { supported: { type: "boolean" } },
        required: ["supported"],
        additionalProperties: false,
      },
    },
  },
  messages: [
    { role: "system", content: "Return the requested JSON object." },
    { role: "user", content: 'Return {"supported":true}.' },
  ],
};

async function probeStructuredOutputSupport() {
  try {
    const { response } = await openAIRequest(structuredOutputProbeBody, 30_000);
    if (response.ok) {
      structuredOutputSupport = "supported";
    } else if (response.status === 400 || response.status === 422) {
      structuredOutputSupport = "unsupported";
    }
    console.log(`[openai] structured-output support: ${structuredOutputSupport}`);
  } catch {
    console.log("[openai] structured-output support: unknown");
  }
}

const structuredOutputProbe = probeStructuredOutputSupport();

type ChatMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
};

type ChatPayload = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ChatMessage["tool_calls"];
    };
  }>;
};

async function searchWeb(query: string) {
  const url = `${searxngBaseUrl}/search?q=${encodeURIComponent(query)}&format=json&language=en`;
  console.log(`[searxng] request ${JSON.stringify({ method: "GET", url })}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const rawBody = await response.text();
    console.log(
      `[searxng] response ${JSON.stringify({
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: rawBody,
      })}`,
    );
    if (!response.ok) return "No search results found.";
    const data = JSON.parse(rawBody) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const results = data.results?.slice(0, 5) ?? [];
    if (!results.length) return "No search results found.";
    return results
      .map(
        (result) =>
          `Title: ${result.title ?? "N/A"}\nURL: ${result.url ?? "N/A"}\nContent: ${result.content ?? "N/A"}`,
      )
      .join("\n\n");
  } catch (error) {
    console.error(
      `[searxng] request failed ${JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
    return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function completeWithTools(initialBody: {
  messages: ChatMessage[];
  [key: string]: unknown;
}): Promise<ChatPayload> {
  let body = initialBody;
  for (let turn = 0; turn < 5; turn++) {
    const payload = await chatCompletions(body);
    const message = payload.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    if (!toolCalls.length) return payload;

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: message?.content ?? null,
      tool_calls: toolCalls,
    };
    const toolMessages: ChatMessage[] = [];
    for (const toolCall of toolCalls) {
      let result = "Unknown tool.";
      if (toolCall.function.name === "web_search") {
        try {
          const argumentsValue = JSON.parse(toolCall.function.arguments) as { query?: unknown };
          result =
            typeof argumentsValue.query === "string" && argumentsValue.query.trim()
              ? await searchWeb(argumentsValue.query.trim())
              : "Search failed: the query was empty.";
        } catch (error) {
          result = `Search failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      toolMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
    }
    body = {
      ...body,
      messages: [...body.messages, assistantMessage, ...toolMessages],
    };
  }
  throw new Error("The model requested too many web searches.");
}

async function completeReaction(input: ReactionInput): Promise<ChatPayload> {
  await structuredOutputProbe;
  const useStructuredOutput = structuredOutputSupport === "supported";
  const initialBody = buildPrompt(input, useStructuredOutput) as {
    messages: ChatMessage[];
    [key: string]: unknown;
  };
  return completeWithTools(initialBody);
}

function extractJson(content: string): unknown {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to extracting JSON surrounded by prose or a code fence.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Let the caller report invalid JSON.
    }
  }
  throw new Error("Invalid JSON");
}

function selectedStructureCandidate(value: unknown, candidates: StructureCandidate[]) {
  if (!value || typeof value !== "object") return undefined;
  const selection = value as {
    cid?: unknown;
    CID?: unknown;
    selected_cid?: unknown;
    selectedCid?: unknown;
  };
  const cid = selection.cid ?? selection.CID ?? selection.selected_cid ?? selection.selectedCid;
  if (typeof cid !== "number" || !Number.isInteger(cid)) return undefined;
  return candidates.find((candidate) => candidate.cid === cid);
}

async function resolveStructureCandidate(input: {
  formula: string;
  candidates: StructureCandidate[];
  reactants: Species[];
  reactionName?: string;
  condition?: string;
}) {
  await structuredOutputProbe;
  const body = buildStructureSelectionPrompt(input, structuredOutputSupport === "supported") as {
    messages: ChatMessage[];
    [key: string]: unknown;
  };
  const payload = await completeWithTools(body);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("The model returned an empty structure selection.");
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    throw new Error("The model returned invalid structure-selection JSON.");
  }
  const candidate = selectedStructureCandidate(parsed, input.candidates);
  if (!candidate) throw new Error("The model selected a CID outside the PubChem candidates.");
  return { cid: candidate.cid };
}

async function handleStructureResolution(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be JSON." }, 400);
  }
  const value = raw as {
    formula?: unknown;
    candidates?: unknown;
    reactants?: unknown;
    reactionName?: unknown;
    condition?: unknown;
  };
  const formula = typeof value.formula === "string" ? value.formula.trim() : "";
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.flatMap((candidate): StructureCandidate[] => {
        if (!candidate || typeof candidate !== "object") return [];
        const item = candidate as Partial<StructureCandidate>;
        return typeof item.cid === "number" &&
          Number.isInteger(item.cid) &&
          typeof item.name === "string" &&
          typeof item.formula === "string"
          ? [{ cid: item.cid, name: item.name.slice(0, 300), formula: item.formula.slice(0, 120) }]
          : [];
      })
    : [];
  const reactants = sanitizeSpecies(value.reactants);
  if (!formula || !candidates.length || !reactants.length) {
    return jsonResponse({ error: "Provide a formula, PubChem candidates, and reactants." }, 400);
  }
  try {
    return jsonResponse(
      await resolveStructureCandidate({
        formula,
        candidates: candidates.slice(0, 25),
        reactants,
        ...(typeof value.reactionName === "string" && value.reactionName
          ? { reactionName: value.reactionName.slice(0, 300) }
          : {}),
        ...(typeof value.condition === "string" && value.condition
          ? { condition: value.condition.slice(0, 500) }
          : {}),
      }),
    );
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error ? error.message : "The model could not resolve the structure.",
      },
      502,
    );
  }
}

async function handleReactions(request: Request) {
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
    let payload: ChatPayload;
    try {
      payload = await completeReaction(input);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "The model could not be reached.");
    }
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("The model returned an empty response.");
    let parsed: { reactions?: unknown };
    try {
      parsed = extractJson(content) as { reactions?: unknown };
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
    apiKeyPresent: Boolean(openaiApiKey),
    structuredOutputSupport,
    searxngBaseUrl,
    cacheSize: reactionCache.size,
  });
}

async function routeRequest(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/api/reactions") {
    if (request.method === "GET") return handleHealth();
    if (request.method === "POST") return handleReactions(request);
    return jsonResponse({ error: "Method not allowed." }, 405);
  }
  if (url.pathname === "/api/resolve-structure") {
    if (request.method === "POST") return handleStructureResolution(request);
    return jsonResponse({ error: "Method not allowed." }, 405);
  }
  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "Not found." }, 404);
  }
  return serveStatic(url.pathname);
}

const server = serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response: Response;
    try {
      response = await routeRequest(request, url);
    } catch (error) {
      response = jsonResponse(
        { error: error instanceof Error ? error.message : "Internal server error." },
        500,
      );
    }
    if (url.pathname.startsWith("/api/")) {
      console.log(
        `[http] ${request.method} ${url.pathname}${url.search} -> ${response.status} (${
          Date.now() - startedAt
        }ms)`,
      );
    }
    return response;
  },
});

console.log(`Electron API server listening on http://0.0.0.0:${server.port}`);
console.log(`Serving static site from ${root}`);
console.log(`Reaction model: ${openaiModel}${openaiApiKey ? "" : " (keyless)"}`);
