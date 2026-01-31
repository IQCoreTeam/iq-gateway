import { Hono } from "hono";
import { readAsset, generateETag } from "../chain";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../cache";
import { fetchFromPeers } from "../registry";

export const imgRouter = new Hono();

const FETCH_TIMEOUT = 120_000; // 2 min for large files

imgRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  if (sig.endsWith(".png")) sig = sig.slice(0, -4);
  if (sig.endsWith(".jpg")) sig = sig.slice(0, -4);
  if (!sig || sig.length < 80) return c.text("invalid signature", 400);

  const isPeerRequest = c.req.header("X-Peer-Request") === "true";
  const cacheKey = `img:${sig}`;

  // Check local caches
  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("img", sig);
    if (disk) {
      buf = disk;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
    }
  }

  // Check peers (skip if this is already a peer request)
  if (!buf && !isPeerRequest) {
    const peerResult = await fetchFromPeers(`/img/${sig}`);
    if (peerResult) {
      buf = peerResult.data;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("img", sig, buf);
    }
  }

  // Fetch from Solana
  if (!buf) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const { data } = await readAsset(sig);
      clearTimeout(timeout);

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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      if (msg.includes("abort")) return c.text("timeout - file too large", 504);
      console.error("img fetch error:", msg);
      return c.text("failed to fetch", 500);
    }
  }

  // Detect content type from magic bytes
  let contentType = "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) contentType = "image/jpeg";
  else if (buf[0] === 0x47 && buf[1] === 0x49) contentType = "image/gif";
  else if (buf[8] === 0x57 && buf[9] === 0x45) contentType = "image/webp";

  const etag = generateETag(buf);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
