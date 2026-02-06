import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readTableRows } from "../chain";
import { MemoryCache, TTL } from "../cache/memory";
import { getDiskCache, setDiskCache } from "../cache/disk";

export const tableRouter = new Hono();

const rowsCache = new MemoryCache<string>(100);

// In-flight request deduplication — prevents thundering herd on cache miss
const inflight = new Map<string, Promise<string>>();

function isValidPublicKey(key: string): boolean {
  try {
    new PublicKey(key);
    return true;
  } catch {
    return false;
  }
}

function getCacheKey(tablePda: string, limit: number, before?: string): string {
  const raw = `${tablePda}:${limit}:${before || ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function buildResponse(tablePda: string, rows: Record<string, unknown>[], limit: number, before?: string) {
  return {
    tablePda,
    rows,
    count: rows.length,
    limit,
    before: before || null,
    nextCursor: rows.length === limit ? (rows[rows.length - 1] as { __txSignature?: string })?.__txSignature : null,
  };
}

async function fetchFromChain(
  cacheKey: string,
  tablePda: string,
  limit: number,
  before?: string,
): Promise<string> {
  const rows = await readTableRows(tablePda, { limit, before });
  const json = JSON.stringify(buildResponse(tablePda, rows, limit, before));

  rowsCache.set(cacheKey, json, TTL.ROWS);
  setDiskCache("rows", cacheKey, json).catch(() => {});

  return json;
}

function fetchDeduped(
  cacheKey: string,
  tablePda: string,
  limit: number,
  before?: string,
): Promise<string> {
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const promise = fetchFromChain(cacheKey, tablePda, limit, before)
    .finally(() => inflight.delete(cacheKey));

  inflight.set(cacheKey, promise);
  return promise;
}

// GET /table/:tablePda/rows
tableRouter.get("/:tablePda/rows", async (c) => {
  const tablePda = c.req.param("tablePda");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const before = c.req.query("before") || undefined;
  const fresh = c.req.query("fresh") === "true";

  if (!isValidPublicKey(tablePda)) {
    return c.json({ error: "invalid table PDA" }, 400);
  }

  const cacheKey = getCacheKey(tablePda, limit, before);

  if (!fresh) {
    // Tier 1: Memory cache
    const mem = rowsCache.get(cacheKey);
    if (mem) {
      return c.json({ ...JSON.parse(mem), cached: true });
    }

    // Tier 2: Disk cache — serve stale, refresh in background
    const disk = await getDiskCache("rows", cacheKey);
    if (disk) {
      const json = disk.toString("utf8");
      rowsCache.set(cacheKey, json, TTL.ROWS);
      fetchDeduped(cacheKey, tablePda, limit, before).catch(() => {});
      return c.json({ ...JSON.parse(json), cached: true });
    }
  }

  // Tier 3: Chain read with dedup
  try {
    const json = await fetchDeduped(cacheKey, tablePda, limit, before);
    return c.json({ ...JSON.parse(json), cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";

    if (message.includes("not found") || message.includes("Invalid public key")) {
      return c.json({ error: "table not found", tablePda }, 404);
    }

    console.error(`[table] failed to read ${tablePda}:`, message);
    return c.json({ error: "failed to read table" }, 500);
  }
});

// GET /table/cache/stats
tableRouter.get("/cache/stats", (c) => {
  return c.json({
    entries: rowsCache.size(),
    ttl: TTL.ROWS,
    inflight: inflight.size,
  });
});

export { rowsCache, inflight };
