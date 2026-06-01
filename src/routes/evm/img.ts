import { Hono } from "hono";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../../cache";
import { isTxHash } from "../../utils";
import type { EvmEnv } from "../../chain/wrappers";

export const imgRouter = new Hono<EvmEnv>();

imgRouter.get("/:txHash", async (c) => {
  let txHash = c.req.param("txHash");
  if (txHash.endsWith(".png")) txHash = txHash.slice(0, -4);
  if (txHash.endsWith(".jpg")) txHash = txHash.slice(0, -4);
  if (!isTxHash(txHash)) return c.text("invalid tx hash", 400);
  const chain = c.get("chain");
  const network = c.get("network");

  const cacheKey = `${network}:img:${txHash}`;

  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("img", txHash, network);
    if (disk) {
      buf = disk;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
    }
  }

  if (!buf) {
    try {
      const { data } = await chain.readAsset(txHash);
      if (!data) return c.text("not found", 404);
      buf = chain.decodeAssetData(data);
      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("img", txHash, buf, network);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      console.error("img fetch error:", msg);
      return c.text("failed to fetch", 500);
    }
  }

  const contentType = chain.detectImageType(buf) || "image/png";
  const etag = chain.generateETag(buf);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
