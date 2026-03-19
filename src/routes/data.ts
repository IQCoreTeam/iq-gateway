import { Hono } from "hono";
import { readAsset } from "../chain";
import { MemoryCache, TTL, getDiskCache, setDiskCache, deduped } from "../cache";

export const dataRouter = new Hono();

const dataCache = new MemoryCache<string>(1000);
const inflight = new Map<string, Promise<string>>();

dataRouter.get("/:sig", async (c) => {
  const sig = c.req.param("sig");
  if (!sig || sig.length < 80) return c.json({ error: "invalid signature" }, 400);

  const cacheKey = `data:${sig}`;

  // L1: Memory cache
  const cached = dataCache.get(cacheKey);
  if (cached) {
    return c.json(JSON.parse(cached));
  }

  // L2: Disk cache (keyed with "data:" prefix to avoid collision with /meta cache)
  const disk = await getDiskCache("meta", cacheKey);
  if (disk) {
    const text = new TextDecoder().decode(disk);
    dataCache.set(cacheKey, text, TTL.META_IMMUTABLE);
    return c.json(JSON.parse(text));
  }

  // L3: Fetch from chain (deduplicated)
  try {
    const result = await deduped(inflight, cacheKey, async () => {
      const { data, metadata } = await readAsset(sig);
      return JSON.stringify({ data, metadata, signature: sig });
    });

    dataCache.set(cacheKey, result, TTL.META_IMMUTABLE);
    await setDiskCache("meta", cacheKey, Buffer.from(result));

    return c.json(JSON.parse(result));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown error";
    if (msg.includes("not found") || msg.includes("instruction not found")) {
      return c.json({ data: null, metadata: "", signature: sig }, 404);
    }
    console.error("[/data] fetch error:", msg);
    return c.json({ error: "failed to fetch transaction data" }, 500);
  }
});
