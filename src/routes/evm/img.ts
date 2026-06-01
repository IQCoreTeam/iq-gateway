import { Hono } from "hono";
import { readAsset, generateETag, decodeAssetData, detectImageType } from "../../chain/evm";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../../cache";
import { isTxHash } from "../../utils";

export const imgRouter = new Hono();

imgRouter.get("/:txHash", async (c) => {
  let txHash = c.req.param("txHash");
  if (txHash.endsWith(".png")) txHash = txHash.slice(0, -4);
  if (txHash.endsWith(".jpg")) txHash = txHash.slice(0, -4);
  if (!isTxHash(txHash)) return c.text("invalid tx hash", 400);

  const cacheKey = `img:${txHash}`;

  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("img", txHash);
    if (disk) {
      buf = disk;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
    }
  }

  if (!buf) {
    try {
      const { data } = await readAsset(txHash);
      if (!data) return c.text("not found", 404);
      buf = decodeAssetData(data);
      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("img", txHash, buf);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      console.error("img fetch error:", msg);
      return c.text("failed to fetch", 500);
    }
  }

  const contentType = detectImageType(buf) || "image/png";
  const etag = generateETag(buf);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
