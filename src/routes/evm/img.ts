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

  // A code-in row is a JSON envelope {kind, body, who}; the picture is the data
  // URL in `body`. readAsset reassembles that envelope, so normalize here
  // (mirrors the solana img route; not in the shared decoder), repairing old
  // memory/disk entries that cached the raw JSON. Standalone images skip this.
  if (/^\s*\{/.test(buf.subarray(0, 64).toString("utf8"))) {
    let row: { kind?: string; body?: unknown } | undefined;
    try { row = JSON.parse(buf.toString("utf8")); } catch { /* legacy data */ }
    if ((row?.kind === "image" || row?.kind === "file") && typeof row.body === "string") {
      const match = /^data:(image\/(?:png|jpeg|gif|webp))(?:;[^,]*)?;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(row.body);
      if (match) {
        const decoded = Buffer.from(match[2], "base64");
        // Reject malformed base64 and mislabeled/non-image bodies. Do not
        // introduce active SVG/HTML support through the row format.
        if (decoded.toString("base64").replace(/=+$/, "") === match[2].replace(/=+$/, "") &&
            chain.detectImageType(decoded) === match[1].toLowerCase()) {
          buf = decoded;
          imageCache.set(cacheKey, buf, TTL.IMAGE);
          await setDiskCache("img", txHash, buf, network);
        }
      }
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
