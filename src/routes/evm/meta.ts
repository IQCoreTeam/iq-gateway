import { Hono } from "hono";
import { metaCache, TTL, getDiskCache, setDiskCache } from "../../cache";
import { isTxHash } from "../../utils";
import type { EvmEnv } from "../../chain/wrappers";

export const metaRouter = new Hono<EvmEnv>();

interface RawMeta {
  filename?: string;
  symbol?: string;
  description?: string;
  attributes?: { trait_type: string; value: string }[];
  filetype?: string;
}

metaRouter.get("/:txHash", async (c) => {
  let txHash = c.req.param("txHash");
  if (txHash.endsWith(".json")) txHash = txHash.slice(0, -5);
  if (!isTxHash(txHash)) return c.json({ error: "invalid tx hash" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");

  const cacheKey = `${network}:meta:${txHash}`;
  let raw: RawMeta | null = null;

  const cached = metaCache.get(cacheKey);
  if (cached) raw = JSON.parse(cached);

  if (!raw) {
    const disk = await getDiskCache("meta", txHash, network);
    if (disk) {
      raw = JSON.parse(disk.toString("utf8"));
      metaCache.set(cacheKey, disk.toString("utf8"), TTL.META_IMMUTABLE);
    }
  }

  if (!raw) {
    try {
      const { metadata } = await chain.readAsset(txHash);
      if (!metadata) return c.json({ error: "not found" }, 404);
      raw = typeof metadata === "string" ? JSON.parse(metadata) : (metadata as RawMeta);
      const rawStr = JSON.stringify(raw);
      metaCache.set(cacheKey, rawStr, TTL.META_IMMUTABLE);
      await setDiskCache("meta", txHash, rawStr, network);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "fetch failed";
      if (msg.includes("not found") || msg.includes("Unexpected function")) {
        return c.json({ error: "not found" }, 404);
      }
      console.error("meta fetch error:", msg);
      return c.json({ error: "failed to fetch" }, 500);
    }
  }

  if (!raw) return c.json({ error: "not found" }, 404);

  const proto = c.req.header("X-Forwarded-Proto") || "http";
  const host = c.req.header("Host") || "localhost:3000";
  const basePath = process.env.BASE_PATH || "";
  const baseUrl = `${proto}://${host}${basePath}`;

  const name = raw.symbol || raw.filename?.replace(/\.[^.]+$/, "") || "IQ Asset";

  const metaplex = {
    name,
    symbol: raw.symbol || "IQ",
    description: raw.description || "on chain data storage",
    image: `${baseUrl}/img/${txHash}.png`,
    external_url: `${baseUrl}/asset/${txHash}`,
    attributes: raw.attributes || [
      { trait_type: "Storage", value: "On-chain" },
      { trait_type: "Protocol", value: "IQLabs" },
    ],
    properties: {
      files: [{ uri: `${baseUrl}/img/${txHash}.png`, type: raw.filetype || "image/png" }],
      category: "image",
    },
  };

  const jsonStr = JSON.stringify(metaplex);
  const etag = chain.generateETag(jsonStr);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.json(metaplex, 200, {
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
