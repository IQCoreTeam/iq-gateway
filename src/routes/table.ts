import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readTableRows, fetchSignatureIndex, readRowsBySignatures } from "../chain";
import { MemoryCache, TTL } from "../cache/memory";
import { getDiskCache, setDiskCache } from "../cache/disk";

export const tableRouter = new Hono();

const rowsCache = new MemoryCache<string>(100);
const indexCache = new MemoryCache<string>(50);
const sliceCache = new MemoryCache<string>(500);

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

function cacheKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
}

function deduped(key: string, fn: () => Promise<string>): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ─── Existing: /table/:tablePda/rows ───────────────────────────────────────────

function buildRowsResponse(tablePda: string, rows: Record<string, unknown>[], limit: number, before?: string) {
  return {
    tablePda,
    rows,
    count: rows.length,
    limit,
    before: before || null,
    nextCursor: rows.length === limit ? (rows[rows.length - 1] as { __txSignature?: string })?.__txSignature : null,
  };
}

tableRouter.get("/:tablePda/rows", async (c) => {
  const tablePda = c.req.param("tablePda");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const before = c.req.query("before") || undefined;
  const fresh = c.req.query("fresh") === "true";

  if (!isValidPublicKey(tablePda)) {
    return c.json({ error: "invalid table PDA" }, 400);
  }

  const key = cacheKey(tablePda, String(limit), before || "");
  // Latest messages (no cursor) need short TTL so new messages show up fast.
  // Older pages (with cursor) rarely change — keep the longer TTL.
  const ttl = before ? TTL.ROWS : 10_000; // 10s for latest, 5min for older pages

  async function fetchRows(): Promise<string> {
    const rows = await readTableRows(tablePda, { limit, before });
    const json = JSON.stringify(buildRowsResponse(tablePda, rows, limit, before));
    rowsCache.set(key, json, ttl);
    if (before) setDiskCache("rows", key, json).catch(() => {});
    return json;
  }

  if (!fresh) {
    const mem = rowsCache.get(key);
    if (mem) return c.json({ ...JSON.parse(mem), cached: true });

    // Only check disk for paginated (older) rows — latest should always be fresh
    if (before) {
      const disk = await getDiskCache("rows", key);
      if (disk) {
        const json = disk.toString("utf8");
        rowsCache.set(key, json, ttl);
        deduped(key, fetchRows).catch(() => {});
        return c.json({ ...JSON.parse(json), cached: true });
      }
    }
  }

  try {
    const json = await deduped(key, fetchRows);
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

// ─── New: /table/:tablePda/index ───────────────────────────────────────────────
// Returns the full signature list for a table (newest-first).
// Lightweight — only fetches signature metadata, no transaction decoding.
// Cache: 2 minutes in memory, disk stale-while-revalidate.

const INDEX_TTL = 2 * 60 * 1000; // 2 minutes — sig list changes when new messages arrive
const INDEX_MAX_SIGS = 10000;

tableRouter.get("/:tablePda/index", async (c) => {
  const tablePda = c.req.param("tablePda");

  if (!isValidPublicKey(tablePda)) {
    return c.json({ error: "invalid table PDA" }, 400);
  }

  const key = cacheKey("index", tablePda);

  async function fetchIndex(): Promise<string> {
    const signatures = await fetchSignatureIndex(tablePda, INDEX_MAX_SIGS);
    const json = JSON.stringify({ tablePda, signatures, total: signatures.length });
    indexCache.set(key, json, INDEX_TTL);
    setDiskCache("rows", key, json).catch(() => {});
    return json;
  }

  // Memory cache
  const mem = indexCache.get(key);
  if (mem) return c.json({ ...JSON.parse(mem), cached: true });

  // Disk cache — serve stale, refresh in background
  const disk = await getDiskCache("rows", key);
  if (disk) {
    const json = disk.toString("utf8");
    indexCache.set(key, json, INDEX_TTL);
    deduped(key, fetchIndex).catch(() => {});
    return c.json({ ...JSON.parse(json), cached: true });
  }

  try {
    const json = await deduped(key, fetchIndex);
    return c.json({ ...JSON.parse(json), cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    if (message.includes("not found") || message.includes("Invalid public key")) {
      return c.json({ error: "table not found", tablePda }, 404);
    }
    console.error(`[table/index] failed for ${tablePda}:`, message);
    return c.json({ error: "failed to fetch index" }, 500);
  }
});

// ─── New: /table/:tablePda/slice ───────────────────────────────────────────────
// Decodes specific transactions by signature.
// Query: ?sigs=sig1,sig2,...  (max 50 per request)
// Cache: individual rows cached for 1 hour (on-chain data is immutable).
// The full slice response is also cached briefly to handle repeated requests.

const SLICE_MAX = 50;
const SLICE_ROW_TTL = 24 * 60 * 60 * 1000; // 24 hours — on-chain rows are immutable

tableRouter.get("/:tablePda/slice", async (c) => {
  const tablePda = c.req.param("tablePda");
  const sigsParam = c.req.query("sigs");

  if (!isValidPublicKey(tablePda)) {
    return c.json({ error: "invalid table PDA" }, 400);
  }

  if (!sigsParam) {
    return c.json({ error: "sigs query parameter required" }, 400);
  }

  const sigs = sigsParam.split(",").filter(Boolean);
  if (sigs.length === 0) {
    return c.json({ error: "no signatures provided" }, 400);
  }
  if (sigs.length > SLICE_MAX) {
    return c.json({ error: `max ${SLICE_MAX} signatures per request` }, 400);
  }

  const key = cacheKey("slice", tablePda, ...sigs);

  // Check for cached individual rows first, only fetch missing ones
  async function fetchSlice(): Promise<string> {
    const rows: Array<Record<string, unknown>> = [];
    const uncached: string[] = [];

    // Gather cached rows (memory → disk), collect uncached sigs
    for (const sig of sigs) {
      const rowKey = cacheKey("row", sig);
      const mem = sliceCache.get(rowKey);
      if (mem) {
        rows.push(JSON.parse(mem));
        continue;
      }
      const disk = await getDiskCache("rows", rowKey);
      if (disk) {
        const json = disk.toString("utf8");
        sliceCache.set(rowKey, json, SLICE_ROW_TTL);
        rows.push(JSON.parse(json));
        continue;
      }
      uncached.push(sig);
    }

    // Fetch uncached rows from chain
    if (uncached.length > 0) {
      const freshRows = await readRowsBySignatures(uncached);

      // Cache each row individually by its signature
      const freshMap = new Map<string, Record<string, unknown>>();
      for (const row of freshRows) {
        const sig = (row as { __txSignature?: string }).__txSignature;
        if (sig) {
          freshMap.set(sig, row);
          const rowJson = JSON.stringify(row);
          const rowKey = cacheKey("row", sig);
          sliceCache.set(rowKey, rowJson, SLICE_ROW_TTL);
          setDiskCache("rows", rowKey, rowJson).catch(() => {});
        }
      }

      // Merge in order of the original sigs array
      for (const sig of uncached) {
        const row = freshMap.get(sig);
        if (row) rows.push(row);
      }
    }

    // Re-sort to match original sigs order
    const sigOrder = new Map(sigs.map((s, i) => [s, i]));
    rows.sort((a, b) => {
      const aIdx = sigOrder.get((a as { __txSignature?: string }).__txSignature || "") ?? 999;
      const bIdx = sigOrder.get((b as { __txSignature?: string }).__txSignature || "") ?? 999;
      return aIdx - bIdx;
    });

    const json = JSON.stringify({ tablePda, rows, count: rows.length });
    return json;
  }

  try {
    const json = await deduped(key, fetchSlice);
    return c.json({ ...JSON.parse(json), cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.error(`[table/slice] failed for ${tablePda}:`, message);
    return c.json({ error: "failed to decode rows" }, 500);
  }
});

// ─── Cache stats ───────────────────────────────────────────────────────────────

tableRouter.get("/cache/stats", (c) => {
  return c.json({
    rows: { entries: rowsCache.size(), ttl: TTL.ROWS },
    index: { entries: indexCache.size(), ttl: INDEX_TTL },
    slice: { entries: sliceCache.size(), ttl: SLICE_ROW_TTL },
    inflight: inflight.size,
  });
});

export { rowsCache, indexCache, sliceCache, inflight };
