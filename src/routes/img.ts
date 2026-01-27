import { Hono } from "hono";
import { readAsset, generateETag } from "../chain";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../cache";

export const imgRouter = new Hono();

// GET /img/:sig.png - Raw image/data bytes
imgRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  if (sig.endsWith(".png")) sig = sig.slice(0, -4);
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

      // Decode: data URL, base64, or raw
      if (data.startsWith("data:")) {
        buf = Buffer.from(data.split(",")[1], "base64");
      } else if (/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 100))) {
        buf = Buffer.from(data, "base64");
      } else {
        buf = Buffer.from(data);
      }

      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("img", sig, buf);
    } catch (e) {
      console.error("img fetch error:", e);
      return c.text("failed to fetch", 500);
    }
  }

  const etag = generateETag(buf);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=31536000, immutable",
    "ETag": etag,
  });
});
