import { Hono } from "hono";
import { readAsset, generateETag } from "../chain";
import { metaCache, TTL, getDiskCache, setDiskCache } from "../cache";

export const metaRouter = new Hono();

const FETCH_TIMEOUT = 30_000; // 30s for metadata

interface RawMeta {
  filename?: string;
  symbol?: string;
  description?: string;
  attributes?: { trait_type: string; value: string }[];
  filetype?: string;
}

metaRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  if (sig.endsWith(".json")) sig = sig.slice(0, -5);
  if (!sig || sig.length < 80) return c.json({ error: "invalid signature" }, 400);

  const cacheKey = `meta:${sig}`;
  let raw: RawMeta | null = null;

  // Check memory cache
  const cached = metaCache.get(cacheKey);
  if (cached) {
    raw = JSON.parse(cached);
  }

  // Check disk cache
  if (!raw) {
    const disk = await getDiskCache("meta", sig);
    if (disk) {
      raw = JSON.parse(disk.toString("utf8"));
      metaCache.set(cacheKey, disk.toString("utf8"), TTL.META_IMMUTABLE);
    }
  }

  // Fetch from chain
  if (!raw) {
    try {
      const { metadata } = await readAsset(sig);
      if (!metadata) return c.json({ error: "not found" }, 404);
      raw = JSON.parse(metadata);
      const rawStr = JSON.stringify(raw);
      metaCache.set(cacheKey, rawStr, TTL.META_IMMUTABLE);
      await setDiskCache("meta", sig, rawStr);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      console.error("meta fetch error:", msg);
      return c.json({ error: "failed to fetch" }, 500);
    }
  }

  // Build URLs dynamically
  const proto = c.req.header("X-Forwarded-Proto") || "http";
  const host = c.req.header("Host") || "localhost:3000";
  const basePath = process.env.BASE_PATH || "";
  const baseUrl = `${proto}://${host}${basePath}`;

  const name = raw.symbol || raw.filename?.replace(/\.[^.]+$/, "") || "IQ Asset";

  const metaplex = {
    name,
    symbol: raw.symbol || "IQ",
    description: raw.description || "on chain data storage",
    image: `${baseUrl}/img/${sig}.png`,
    external_url: `${baseUrl}/asset/${sig}`,
    attributes: raw.attributes || [
      { trait_type: "Storage", value: "On-chain" },
      { trait_type: "Protocol", value: "IQLabs" },
    ],
    properties: {
      files: [{ uri: `${baseUrl}/img/${sig}.png`, type: raw.filetype || "image/png" }],
      category: "image",
    },
  };

  const jsonStr = JSON.stringify(metaplex);
  const etag = generateETag(jsonStr);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.json(metaplex, 200, {
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
