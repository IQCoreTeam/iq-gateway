import { Hono } from "hono";
import { MemoryCache, TTL, getDiskCache, setDiskCache, deduped } from "../../cache";
import { isTxHash } from "../../utils";
import type { EvmEnv } from "../../chain/wrappers";

export const dataRouter = new Hono<EvmEnv>();

const dataCache = new MemoryCache<string>(1000);
const inflight = new Map<string, Promise<string>>();

dataRouter.get("/:txHash", async (c) => {
  const txHash = c.req.param("txHash");
  if (!isTxHash(txHash)) return c.json({ error: "invalid tx hash" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");

  // Memory + inflight keys are process-shared across networks → namespace them.
  // Disk keys stay bare; the network is threaded into the disk layer instead.
  const cacheKey = `data:${txHash}`;
  const memKey = `${network}:${cacheKey}`;

  const cached = dataCache.get(memKey);
  if (cached) return c.json(JSON.parse(cached));

  const disk = await getDiskCache("meta", cacheKey, network);
  if (disk) {
    const text = new TextDecoder().decode(disk);
    dataCache.set(memKey, text, TTL.META_IMMUTABLE);
    return c.json(JSON.parse(text));
  }

  try {
    const result = await deduped(inflight, memKey, async () => {
      const { data, metadata, signer, blockTime, blockNumber } = await chain.readAsset(txHash);
      return JSON.stringify({ data, metadata, txHash, signer, blockTime, blockNumber });
    });

    dataCache.set(memKey, result, TTL.META_IMMUTABLE);
    await setDiskCache("meta", cacheKey, Buffer.from(result), network);

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
