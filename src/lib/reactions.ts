type ReportedReaction = {
  status: "reported";
  source: "ord" | "rhea" | "cantera" | "phreeqc";
  sourceId: string;
  confidence: number;
  reactants: Array<{
    inchiKey?: string;
    smiles?: string;
    formula?: string;
    query?: string;
    coefficient?: number;
  }>;
  products: Array<{
    inchiKey?: string;
    smiles?: string;
    formula?: string;
    query?: string;
    coefficient?: number;
  }>;
  condition?: string;
};

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(message: string) {
  const input = new TextEncoder().encode(message);
  const padded = new Uint8Array(64 * Math.ceil((input.length + 9) / 64));
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = BigInt(input.length * 8);
  view.setUint32(padded.length - 8, Number(bits >> 32n));
  view.setUint32(padded.length - 4, Number(bits & 0xffffffffn));

  const words = new Uint32Array(64);
  let [a, b, c, d, e, f, g, h] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 =
        ((words[i - 15] >>> 7) | (words[i - 15] << 25)) ^
        ((words[i - 15] >>> 18) | (words[i - 15] << 14)) ^
        (words[i - 15] >>> 3);
      const s1 =
        ((words[i - 2] >>> 17) | (words[i - 2] << 15)) ^
        ((words[i - 2] >>> 19) | (words[i - 2] << 13)) ^
        (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [aa, bb, cc, dd, ee, ff, gg, hh] = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 64; i++) {
      const bigS1 =
        ((ee >>> 6) | (ee << 26)) ^ ((ee >>> 11) | (ee << 21)) ^ ((ee >>> 25) | (ee << 7));
      const choose = (ee & ff) ^ (~ee & gg);
      const temp1 = (hh + bigS1 + choose + SHA256_K[i] + words[i]) >>> 0;
      const bigS0 =
        ((aa >>> 2) | (aa << 30)) ^ ((aa >>> 13) | (aa << 19)) ^ ((aa >>> 22) | (aa << 10));
      const majority = (aa & bb) ^ (aa & cc) ^ (bb & cc);
      const temp2 = (bigS0 + majority) >>> 0;
      hh = gg;
      gg = ff;
      ff = ee;
      ee = (dd + temp1) >>> 0;
      dd = cc;
      cc = bb;
      bb = aa;
      aa = (temp1 + temp2) >>> 0;
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
    e = (e + ee) >>> 0;
    f = (f + ff) >>> 0;
    g = (g + gg) >>> 0;
    h = (h + hh) >>> 0;
  }
  return hex(
    new Uint8Array(
      [a, b, c, d, e, f, g, h].flatMap((word) => [
        word >>> 24,
        (word >>> 16) & 0xff,
        (word >>> 8) & 0xff,
        word & 0xff,
      ]),
    ),
  );
}

async function sha256(key: string) {
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    return hex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))),
    );
  }
  return sha256Hex(key);
}

async function lookupKey(key: string) {
  const digest = await sha256(key);
  const shard = (Number.parseInt(digest.slice(0, 3), 16) % 1024).toString(16).padStart(3, "0");
  const response = await fetch(`./reactions/${shard}.json.gz`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Reaction index returned ${response.status}.`);
  if (!response.body) return [];
  const decompressed = new Response(response.body.pipeThrough(new DecompressionStream("gzip")));
  const reactions = (await decompressed.json()) as Record<string, ReportedReaction[]>;
  return reactions[key] ?? [];
}

export async function lookupReportedReactions(inchiKeys: string[], formulas: string[]) {
  const keys = [
    [...new Set(inchiKeys)].sort().join("|"),
    `formula:${[...new Set(formulas)].sort().join("|")}`,
  ].filter(Boolean);
  const matches = (await Promise.all([...new Set(keys)].map(lookupKey))).flat();
  return [
    ...new Map(
      matches.map((reaction) => [`${reaction.source}:${reaction.sourceId}`, reaction]),
    ).values(),
  ];
}
