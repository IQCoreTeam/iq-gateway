import { Hono } from "hono";
import { readAsset, generateETag } from "../chain/solana";
import { MemoryCache, TTL, getDiskCache, setDiskCache, deduped } from "../cache";

export const tokenMetaRouter = new Hono();

const tokenMetaCache = new MemoryCache<string>(1000);
const inflight = new Map<string, Promise<string>>();

// Serves the plain code-in body of a transaction verbatim, with no wrapper.
// Token launchers inscribe their Metaplex JSON with writer.codeIn and point the
// coin's on-chain uri here, so pump.fun/wallets/dexscreener fetch this URL
// directly and read name/symbol/image/description out of the body as-is.
//
// Distinct from /meta/{sig}, which synthesises its own Metaplex envelope around
// an inscription, and from /data/{sig}, which wraps the same bytes in
// {data, metadata, signature, ...}. Both wrappers are unusable as a token uri.
//
// The path is frozen: it is baked into the on-chain uri of already-minted coins.
tokenMetaRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  if (sig.endsWith(".json")) sig = sig.slice(0, -5);
  if (!sig || sig.length < 80) return c.json({ error: "invalid signature" }, 400);

  const fresh = c.req.query("fresh") === "1";
  const cacheKey = `token-meta:${sig}`;
  let body: string | null = null;

  // `?fresh=1` skips both caches and recomputes, overwriting the stored entry.
  if (!fresh) {
    body = tokenMetaCache.get(cacheKey) ?? null;

    if (body === null) {
      const disk = await getDiskCache("meta", cacheKey);
      if (disk) {
        body = new TextDecoder().decode(disk);
        tokenMetaCache.set(cacheKey, body, TTL.META_IMMUTABLE);
      }
    }
  }

  if (body === null) {
    try {
      body = await deduped(inflight, cacheKey, async () => {
        const { data } = await readAsset(sig);
        // A tx that exists but carries no code-in payload is a 404, not a 500.
        if (data === null || data === undefined) throw new Error("not found");
        return typeof data === "string" ? data : new TextDecoder().decode(data);
      });

      tokenMetaCache.set(cacheKey, body, TTL.META_IMMUTABLE);
      await setDiskCache("meta", cacheKey, Buffer.from(body));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      if (msg.includes("not found") || msg.includes("instruction not found")) {
        return c.json({ error: "not found" }, 404);
      }
      console.error("[/token-meta] fetch error:", msg);
      return c.json({ error: "failed to fetch transaction data" }, 500);
    }
  }

  const etag = generateETag(body);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  // Body is returned verbatim — the inscribed bytes are the response.
  return c.body(body, 200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
