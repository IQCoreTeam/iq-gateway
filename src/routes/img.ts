import { Hono } from "hono";
import { readAsset, generateETag, decodeAssetData, detectImageType } from "../chain";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../cache";

export const imgRouter = new Hono();

imgRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  if (sig.endsWith(".png")) sig = sig.slice(0, -4);
  if (sig.endsWith(".jpg")) sig = sig.slice(0, -4);
  if (!sig || sig.length < 80) return c.text("invalid signature", 400);

  const cacheKey = `img:${sig}`;

  // Check caches
  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("img", sig);
    if (disk) {
      buf = disk;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
    }
  }

  if (!buf) {
    try {
      const { data } = await readAsset(sig);
      if (!data) return c.text("not found", 404);

      buf = decodeAssetData(data);

      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("img", sig, buf);
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
