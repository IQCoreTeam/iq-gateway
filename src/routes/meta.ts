import { Hono } from "hono";
import { readAsset, generateETag } from "../chain";
import { metaCache, TTL, getDiskCache, setDiskCache } from "../cache";

export const metaRouter = new Hono();

metaRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  if (sig.endsWith(".json")) sig = sig.slice(0, -5);
  if (!sig || sig.length < 80) return c.json({ error: "invalid signature" }, 400);

  const cacheKey = `meta:${sig}`;

  // Get raw metadata (cached without URLs)
  let raw: { filename?: string; symbol?: string; description?: string; attributes?: unknown[]; filetype?: string } | null = null;

  const cached = metaCache.get(cacheKey);
  if (cached) {
    raw = JSON.parse(cached);
  } else {
    const disk = await getDiskCache("meta", sig);
    if (disk) {
      raw = JSON.parse(disk.toString("utf8"));
      metaCache.set(cacheKey, disk.toString("utf8"), TTL.META_IMMUTABLE);
    }
  }

  if (!raw) {
    try {
      const { metadata } = await readAsset(sig);
      if (!metadata) return c.json({ error: "not found" }, 404);
      raw = JSON.parse(metadata);
      const rawStr = JSON.stringify(raw);
      metaCache.set(cacheKey, rawStr, TTL.META_IMMUTABLE);
      await setDiskCache("meta", sig, rawStr);
    } catch {
      return c.json({ error: "failed to fetch" }, 500);
    }
  }

  // Build URLs dynamically (not cached)
  const proto = c.req.header("X-Forwarded-Proto") || "http";
  const host = c.req.header("Host") || "localhost:3000";
  const basePath = process.env.BASE_PATH || "";
  const baseUrl = `${proto}://${host}${basePath}`;

  const metaplex = {
    name: raw.symbol || "IQTEST",
    symbol: raw.symbol || "IQTEST",
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
      creators: [{ address: "F5siGzyjsyD6q7yxwJQ4GWzLYEQHVAxwmYiJYGABAqp3", share: 100 }],
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
