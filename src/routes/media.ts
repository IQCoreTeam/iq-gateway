import { Hono } from "hono";
import { MemoryCache, TTL, deduped } from "../cache";
import type { ChainWrapper } from "../chain/wrappers";
import { isSolanaId, isTxHash } from "../utils";
import { parseRange } from "./site";

// Only passive media is served inline. Never fetch URLs embedded in a row.
const MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg",
  "audio/mp4", "audio/aac", "audio/flac", "video/mp4", "video/webm", "video/ogg",
]);
const MAX_ENCODED_BYTES = 8 * 1024 * 1024;
const cache = new MemoryCache<{ mime: string; bytes: Buffer }>(16);
const inflight = new Map<string, Promise<Record<string, unknown> | null>>();

export const mediaRouter = new Hono<{ Variables: { chain: Pick<ChainWrapper, "kind" | "network" | "readSingleRow"> } }>();

mediaRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const chain = c.get("chain");
  if (chain.kind === "solana" ? !(id.length >= 80 && isSolanaId(id)) : !isTxHash(id)) {
    return c.json({ error: "invalid transaction ID" }, 400);
  }
  const key = `${chain.network}:media:${id}`;
  let media = cache.get(key);
  if (!media) {
    let row;
    try { row = await deduped(inflight, key, () => chain.readSingleRow(id)); }
    catch { return c.json({ error: "could not read inscription" }, 502); }
    if (!row) return c.json({ error: "inscription not found" }, 404);
    const body = row.body ?? row.data;
    if (typeof body !== "string") return c.json({ error: "unsupported media payload" }, 415);
    if (body.length > MAX_ENCODED_BYTES) return c.json({ error: "media exceeds the 8 MiB encoded limit" }, 413);
    // Code In filename parameters are ignored, never reflected in headers.
    const match = /^data:([^;,]+)(?:;name=(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})*)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(body);
    if (!match || !MEDIA_TYPES.has(match[1].toLowerCase())) return c.json({ error: "unsupported media type" }, 415);
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.toString("base64") !== match[2]) return c.json({ error: "invalid media encoding" }, 422);
    media = { mime: match[1].toLowerCase(), bytes };
    cache.set(key, media, TTL.META_IMMUTABLE);
  }
  const headers: Record<string, string> = {
    "Content-Type": media.mime, "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*",
  };
  const requested = c.req.header("Range");
  const range = parseRange(requested, media.bytes.length);
  if (requested && !range) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${media.bytes.length}` } });
  }
  const body = range ? media.bytes.subarray(range.start, range.end + 1) : media.bytes;
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${media.bytes.length}`;
  headers["Content-Length"] = String(body.length);
  return new Response(new Uint8Array(body), { status: range ? 206 : 200, headers });
});
