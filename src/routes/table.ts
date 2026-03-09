import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { fetchSignatureIndex, readRowsBySignatures, fetchRecentSignatures, readSingleRow } from "../chain";
import { MemoryCache, TTL, getDiskCache, setDiskCache, deduped } from "../cache";

export const tableRouter = new Hono();

const rowsCache = new MemoryCache<string>(500);
const indexCache = new MemoryCache<string>(50);
const sliceCache = new MemoryCache<string>(2000);

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

// ─── Throttled background refresh ────────────────────────────────────────────
// Only allow one background refresh per key per interval.
// Prevents thundering herd when many clients poll the same head page.

const lastRefresh = new Map<string, number>();
const REFRESH_INTERVAL = 30_000; // Min 30s between background refreshes per key

function shouldRefresh(key: string): boolean {
  const now = Date.now();
  const last = lastRefresh.get(key) || 0;
  if (now - last < REFRESH_INTERVAL) return false;
  lastRefresh.set(key, now);
  return true;
}

// Periodic cleanup of stale refresh timestamps (every 5 min)
setInterval(() => {
  const cutoff = Date.now() - REFRESH_INTERVAL * 4;
  for (const [k, t] of lastRefresh) {
    if (t < cutoff) lastRefresh.delete(k);
  }
}, 5 * 60 * 1000);

// ─── /table/:tablePda/rows ───────────────────────────────────────────────────

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

const HEAD_TTL = 60_000; // 60s memory TTL for head page
const SLICE_ROW_TTL = 24 * 60 * 60 * 1000; // 24h — on-chain rows are immutable

tableRouter.get("/:tablePda/rows", async (c) => {
  const tablePda = c.req.param("tablePda");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const before = c.req.query("before") || undefined;
  const fresh = c.req.query("fresh") === "true";

  if (!isValidPublicKey(tablePda)) {
    return c.json({ error: "invalid table PDA" }, 400);
  }

  const key = cacheKey(tablePda, String(limit), before || "");
  const isHead = !before;
  const ttl = isHead ? HEAD_TTL : TTL.ROWS;

  async function fetchRows(): Promise<string> {
    // Phase 1: lightweight sig scan (1 RPC call)
    const signatures = await fetchRecentSignatures(tablePda, limit, before);

    // Phase 2: resolve rows — check per-sig 24h cache first, only fetch uncached
    const rows: Record<string, unknown>[] = [];
    const uncached: string[] = [];

    for (const sig of signatures) {
      const rowKey = cacheKey("row", sig);
      const mem = sliceCache.get(rowKey);
      if (mem) {
        if (mem !== "null") rows.push(JSON.parse(mem));
        continue;
      }
      const disk = await getDiskCache("rows", rowKey);
      if (disk) {
        const json = disk.toString("utf8");
        sliceCache.set(rowKey, json, SLICE_ROW_TTL);
        if (json !== "null") rows.push(JSON.parse(json));
        continue;
      }
      uncached.push(sig);
    }

    // Phase 3: fetch only truly new rows from RPC
    if (uncached.length > 0) {
      for (const sig of uncached) {
        const row = await readSingleRow(sig);
        const rowKey = cacheKey("row", sig);
        if (row) {
          const txSig = (row as { __txSignature?: string }).__txSignature || sig;
          const rowJson = JSON.stringify(row);
          const rk = cacheKey("row", txSig);
          sliceCache.set(rk, rowJson, SLICE_ROW_TTL);
          setDiskCache("rows", rk, rowJson).catch(() => {});
          rows.push(row);
        } else {
          // Cache non-row sigs (table creation etc.) so we don't re-fetch them
          sliceCache.set(rowKey, "null", SLICE_ROW_TTL);
        }
      }
    }

    // Maintain signature order
    const sigOrder = new Map(signatures.map((s, i) => [s, i]));
    rows.sort((a, b) => {
      const aIdx = sigOrder.get((a as { __txSignature?: string }).__txSignature || "") ?? 999;
      const bIdx = sigOrder.get((b as { __txSignature?: string }).__txSignature || "") ?? 999;
      return aIdx - bIdx;
    });

    const json = JSON.stringify(buildRowsResponse(tablePda, rows, limit, before));
    rowsCache.set(key, json, ttl);
    setDiskCache("rows", key, json).catch(() => {});
    return json;
  }

  if (!fresh) {
    // Memory cache hit
    const mem = rowsCache.get(key);
    if (mem) {
      // Head page: throttled background refresh (max once per 30s per key)
      if (isHead && shouldRefresh(key)) {
        deduped(inflight, key, fetchRows).catch(() => {});
      }
      return c.json({ ...JSON.parse(mem), cached: true });
    }

    // Disk cache hit — serve immediately, no background refresh
    // (memory cache will expire, triggering a fresh fetch next time)
    const disk = await getDiskCache("rows", key);
    if (disk) {
      const json = disk.toString("utf8");
      rowsCache.set(key, json, ttl);
      return c.json({ ...JSON.parse(json), cached: true });
    }
  }

  try {
    const json = await deduped(inflight, key, fetchRows);
    return c.json({ ...JSON.parse(json), cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    if (message.includes("not found") || message.includes("Invalid public key")) {
      return c.json({ error: "table not found", tablePda }, 404);
    }
    // Serve stale disk cache on RPC failure instead of 500
    const stale = await getDiskCache("rows", key);
    if (stale) {
      const json = stale.toString("utf8");
      rowsCache.set(key, json, ttl);
      console.warn(`[table] RPC failed for ${tablePda}, serving stale cache`);
      return c.json({ ...JSON.parse(json), cached: true });
    }
    console.error(`[table] failed to read ${tablePda}:`, message);
    return c.json({ error: "failed to read table" }, 500);
  }
});

// ─── /table/:tablePda/index ──────────────────────────────────────────────────

const INDEX_TTL = 2 * 60 * 1000; // 2 min
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

  // Disk cache — serve stale, NO background refresh
  // Memory TTL handles staleness; next miss after 2 min triggers fresh fetch
  const disk = await getDiskCache("rows", key);
  if (disk) {
    const json = disk.toString("utf8");
    indexCache.set(key, json, INDEX_TTL);
    return c.json({ ...JSON.parse(json), cached: true });
  }

  try {
    const json = await deduped(inflight, key, fetchIndex);
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

// ─── /table/:tablePda/slice ──────────────────────────────────────────────────

const SLICE_MAX = 50;

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

  async function fetchSlice(): Promise<string> {
    const rows: Array<Record<string, unknown>> = [];
    const uncached: string[] = [];

    for (const sig of sigs) {
      const rowKey = cacheKey("row", sig);
      const mem = sliceCache.get(rowKey);
      if (mem) {
        if (mem !== "null") rows.push(JSON.parse(mem));
        continue;
      }
      const disk = await getDiskCache("rows", rowKey);
      if (disk) {
        const json = disk.toString("utf8");
        sliceCache.set(rowKey, json, SLICE_ROW_TTL);
        if (json !== "null") rows.push(JSON.parse(json));
        continue;
      }
      uncached.push(sig);
    }

    if (uncached.length > 0) {
      const freshRows = await readRowsBySignatures(uncached);
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
      for (const sig of uncached) {
        const row = freshMap.get(sig);
        if (row) rows.push(row);
      }
    }

    const sigOrder = new Map(sigs.map((s, i) => [s, i]));
    rows.sort((a, b) => {
      const aIdx = sigOrder.get((a as { __txSignature?: string }).__txSignature || "") ?? 999;
      const bIdx = sigOrder.get((b as { __txSignature?: string }).__txSignature || "") ?? 999;
      return aIdx - bIdx;
    });

    return JSON.stringify({ tablePda, rows, count: rows.length });
  }

  try {
    const json = await deduped(inflight, key, fetchSlice);
    return c.json({ ...JSON.parse(json), cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.error(`[table/slice] failed for ${tablePda}:`, message);
    return c.json({ error: "failed to decode rows" }, 500);
  }
});

// ─── Cache stats ─────────────────────────────────────────────────────────────

tableRouter.get("/cache/stats", (c) => {
  return c.json({
    rows: { entries: rowsCache.size(), ttl: HEAD_TTL },
    index: { entries: indexCache.size(), ttl: INDEX_TTL },
    slice: { entries: sliceCache.size(), ttl: SLICE_ROW_TTL },
    inflight: inflight.size,
    refreshThrottles: lastRefresh.size,
  });
});

export { rowsCache, indexCache, sliceCache, inflight };
