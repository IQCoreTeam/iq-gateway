import { Hono } from "hono";
import { readAsset } from "../../chain/evm";
import { MemoryCache, TTL, getDiskCache, setDiskCache, deduped } from "../../cache";
import { isTxHash } from "../../utils";

export const dataRouter = new Hono();

const dataCache = new MemoryCache<string>(1000);
const inflight = new Map<string, Promise<string>>();

dataRouter.get("/:txHash", async (c) => {
  const txHash = c.req.param("txHash");
  if (!isTxHash(txHash)) return c.json({ error: "invalid tx hash" }, 400);

  const cacheKey = `data:${txHash}`;

  const cached = dataCache.get(cacheKey);
  if (cached) return c.json(JSON.parse(cached));

  const disk = await getDiskCache("meta", cacheKey);
  if (disk) {
    const text = new TextDecoder().decode(disk);
    dataCache.set(cacheKey, text, TTL.META_IMMUTABLE);
    return c.json(JSON.parse(text));
  }

  try {
    const result = await deduped(inflight, cacheKey, async () => {
      const { data, metadata, signer, blockTime, blockNumber } = await readAsset(txHash);
      return JSON.stringify({ data, metadata, txHash, signer, blockTime, blockNumber });
    });

    dataCache.set(cacheKey, result, TTL.META_IMMUTABLE);
    await setDiskCache("meta", cacheKey, Buffer.from(result));

    return c.json(JSON.parse(result));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown error";
    if (msg.includes("not found") || msg.includes("Unexpected function")) {
      return c.json({ data: null, metadata: "", txHash }, 404);
    }
    console.error("[/data] fetch error:", msg);
    return c.json({ error: "failed to fetch transaction data" }, 500);
  }
});
