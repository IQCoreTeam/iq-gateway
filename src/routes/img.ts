import { Hono } from "hono";
import { readAsset, generateETag, decodeAssetData, detectImageType, parseRecord } from "../chain/solana";
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

  // Code-In rows wrap images in a {kind,body,who} envelope. Unwrap via the
  // shared parser (also covers old memory/disk entries containing the JSON).
  // Existing standalone images never enter this path.
  const row = parseRecord(buf);
  if (row && (row.kind === "image" || row.kind === "file") && typeof row.body === "string") {
    const match = /^data:(image\/(?:png|jpeg|gif|webp))(?:;[^,]*)?;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(row.body);
    if (match) {
      const decoded = Buffer.from(match[2], "base64");
      // Reject malformed base64 and mislabeled/non-image bodies. Do not
      // introduce active SVG/HTML support through the new row format.
      if (decoded.toString("base64").replace(/=+$/, "") === match[2].replace(/=+$/, "") &&
          detectImageType(decoded) === match[1].toLowerCase()) {
        buf = decoded;
        imageCache.set(cacheKey, buf, TTL.IMAGE);
        await setDiskCache("img", sig, buf);
      }
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
