// /table/:dbRootId/:tableName/* — paginated rows, index, slice, meta,
// notify (cache warm + SSE push), subscribe (SSE), thread resolver.
//
// Multi-chain: chain funcs come from ctx (c.get("chain")) — the per-network EVM
// wrapper chosen by the resolver — and `network` (c.get("network")) is folded
// into every cache key + disk call so the same (dbRootId,tableName) / row tx
// hash on sepolia vs monad never share a cache entry.

import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { createHash } from "node:crypto";
import { MemoryCache, TTL, getDiskCache, setDiskCache, deduped } from "../../cache";
import { ingestRow } from "../../cache/catalog-ingest.evm";
import { invalidateUserAssets } from "./user";
import { isTxHash, isEvmAddress } from "../../utils";
import type { EvmEnv, EvmWrapper } from "../../chain/wrappers";

export const tableRouter = new Hono<EvmEnv>();

type Row = Record<string, unknown>;
interface RowsCacheEntry {
  json: string;
  rows?: Row[];
  lastTimestamp?: number;
}

const rowsCache = new MemoryCache<RowsCacheEntry>(500);
const indexCache = new MemoryCache<string>(50);
const sliceCache = new MemoryCache<string>(2000);
const inflight = new Map<string, Promise<unknown>>();

// network is the first component of every key, so memory caches (which are
// process-shared across networks) stay network-isolated.
function cacheKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
}

function rowsInflightKey(kind: "fetch" | "refresh", key: string): string {
  return `rows:${kind}:${key}`;
}

function etagFor(json: string): string {
  return `W/"${createHash("sha256").update(json).digest("hex").slice(0, 16)}"`;
}

function respondWithEtag(c: Context, body: Record<string, unknown>, etag: string): Response {
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  c.header("ETag", etag);
  return c.json(body);
}

const lastRefresh = new Map<string, number>();
const REFRESH_INTERVAL = 30_000;

function shouldRefresh(key: string): boolean {
  const now = Date.now();
  const last = lastRefresh.get(key) || 0;
  if (now - last < REFRESH_INTERVAL) return false;
  lastRefresh.set(key, now);
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - REFRESH_INTERVAL * 4;
  for (const [k, t] of lastRefresh) if (t < cutoff) lastRefresh.delete(k);
}, 5 * 60 * 1000);

// ─── /table/:dbRootId/:tableName/rows ────────────────────────────────────────

const HEAD_TTL = 60_000;
const SLICE_ROW_TTL = 24 * 60 * 60 * 1000;

function buildRowsResponse(dbRootId: string, tableName: string, rows: Row[], limit: number, before?: string) {
  const pageRows = rows.slice(0, limit);
  return {
    dbRootId,
    tableName,
    rows: pageRows,
    count: pageRows.length,
    limit,
    before: before || null,
    nextCursor: pageRows.length === limit ? (pageRows[pageRows.length - 1] as { __txHash?: string })?.__txHash : null,
  };
}

function lazyIngestRows(network: string, dbRootId: string, tableName: string, rows: Row[]): void {
  if (rows.length === 0) return;
  void (async () => {
    try {
      for (const row of rows) {
        const txHash = (row as { __txHash?: string }).__txHash;
        if (!txHash) continue;
        await ingestRow({ row: row as Record<string, unknown>, txHash, dbrootLabel: dbRootId, tableLabel: tableName, network });
      }
    } catch (e) {
      console.warn("[catalog] lazy ingest failed:", e instanceof Error ? e.message : e);
    }
  })();
}

async function fetchRowsCold(
  chain: EvmWrapper,
  network: string,
  dbRootId: string,
  tableName: string,
  key: string,
  limit: number,
  before: string | undefined,
  ttl: number,
): Promise<RowsCacheEntry> {
  // SDK walks the tx-chain. Apply `before` cursor in-memory since the SDK
  // doesn't accept one yet (pull a window, slice past the cursor sig).
  const window = before ? limit * 4 : limit;
  let rows = await chain.readTableRows(dbRootId, tableName, { limit: window });
  if (before) {
    const idx = rows.findIndex((r) => (r as { __txHash?: string }).__txHash === before);
    rows = idx >= 0 ? rows.slice(idx + 1, idx + 1 + limit) : rows.slice(0, limit);
  } else {
    rows = rows.slice(0, limit);
  }

  const json = JSON.stringify(buildRowsResponse(dbRootId, tableName, rows, limit, before));
  const entry: RowsCacheEntry = before
    ? { json }
    : { json, rows, lastTimestamp: (await chain.getTableMetaCached(dbRootId, tableName))?.lastTimestamp ?? 0 };
  rowsCache.set(key, entry, ttl);
  if (rows.length > 0) setDiskCache("rows", key, json, network).catch(() => {});
  console.log(`[rows] ${network}/${dbRootId}/${tableName} rows=${rows.length}`);
  lazyIngestRows(network, dbRootId, tableName, rows);
  return entry;
}

async function backgroundRefresh(
  chain: EvmWrapper,
  network: string,
  dbRootId: string,
  tableName: string,
  key: string,
  limit: number,
  ttl: number,
): Promise<void> {
  const entry = rowsCache.get(key);
  if (!entry || !entry.rows) return;

  const meta = await chain.getTableMetaCached(dbRootId, tableName);
  if (!meta) return;

  if (meta.lastTimestamp === entry.lastTimestamp) return;

  // Cheap path: pull the newest head page and merge anything we haven't seen.
  let newRows: Row[] = [];
  try {
    newRows = await chain.readTableRows(dbRootId, tableName, { limit });
  } catch (e) {
    console.warn("[rows:bg] refresh fetch failed:", e instanceof Error ? e.message : e);
    return;
  }
  const existing = new Set(entry.rows.map((r) => (r as { __txHash?: string }).__txHash));
  const trulyNew = newRows.filter((r) => !existing.has((r as { __txHash?: string }).__txHash));
  if (trulyNew.length === 0) {
    entry.lastTimestamp = meta.lastTimestamp;
    rowsCache.set(key, entry, ttl);
    return;
  }
  entry.rows = [...trulyNew, ...entry.rows].slice(0, limit);
  entry.lastTimestamp = meta.lastTimestamp;
  entry.json = JSON.stringify(buildRowsResponse(dbRootId, tableName, entry.rows, limit, undefined));
  rowsCache.set(key, entry, ttl);
  setDiskCache("rows", key, entry.json, network).catch(() => {});
  console.log(`[rows:bg] ${network}/${dbRootId}/${tableName} +${trulyNew.length}`);
}

tableRouter.get("/:dbRootId/:tableName/rows", async (c) => {
  const dbRootId = c.req.param("dbRootId");
  const tableName = c.req.param("tableName");
  const chain = c.get("chain");
  const network = c.get("network");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const before = c.req.query("before") || undefined;
  const fresh = c.req.query("fresh") === "true";

  const key = cacheKey(network, dbRootId, tableName, String(limit), before || "");
  const isHead = !before;
  const ttl = isHead ? HEAD_TTL : TTL.ROWS;

  if (!fresh) {
    const mem = rowsCache.get(key);
    if (mem) {
      if (isHead && shouldRefresh(key)) {
        deduped(inflight, rowsInflightKey("refresh", key), () =>
          backgroundRefresh(chain, network, dbRootId, tableName, key, limit, ttl),
        ).catch(() => {});
      }
      return respondWithEtag(c, { ...JSON.parse(mem.json), cached: true }, etagFor(mem.json));
    }

    const disk = await getDiskCache("rows", key, network);
    if (disk) {
      const json = disk.toString("utf8");
      const entry: RowsCacheEntry = isHead
        ? { json, rows: (JSON.parse(json).rows ?? []) as Row[] }
        : { json };
      rowsCache.set(key, entry, ttl);
      if (isHead && entry.rows) lazyIngestRows(network, dbRootId, tableName, entry.rows);
      return respondWithEtag(c, { ...JSON.parse(json), cached: true }, etagFor(json));
    }
  }

  try {
    const entry = await deduped(inflight, rowsInflightKey("fetch", key), () =>
      fetchRowsCold(chain, network, dbRootId, tableName, key, limit, before, ttl),
    );
    return respondWithEtag(c, { ...JSON.parse(entry.json), cached: false }, etagFor(entry.json));
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    if (message.includes("Table not found")) {
      return c.json({ error: "table not found", dbRootId, tableName }, 404);
    }
    const stale = await getDiskCache("rows", key, network);
    if (stale) {
      const json = stale.toString("utf8");
      const entry: RowsCacheEntry = isHead
        ? { json, rows: (JSON.parse(json).rows ?? []) as Row[] }
        : { json };
      rowsCache.set(key, entry, ttl);
      console.warn(`[table] RPC failed for ${dbRootId}/${tableName}, serving stale`);
      return respondWithEtag(c, { ...JSON.parse(json), cached: true }, etagFor(json));
    }
    console.error(`[table] failed:`, message);
    return c.json({ error: "failed to read table" }, 500);
  }
});

// ─── /table/:dbRootId/:tableName/subscribe (SSE) ─────────────────────────────

const subscribers = new Map<string, Set<SSEStreamingApi>>();

function subKey(network: string, dbRootId: string, tableName: string): string {
  return `${network}::${dbRootId}::${tableName}`;
}

function publishToSubscribers(network: string, dbRootId: string, tableName: string, row: Row): void {
  const set = subscribers.get(subKey(network, dbRootId, tableName));
  if (!set || set.size === 0) return;
  const data = JSON.stringify({ row });
  for (const stream of set) stream.writeSSE({ event: "row", data }).catch(() => {});
}

tableRouter.get("/:dbRootId/:tableName/subscribe", (c) => {
  const dbRootId = c.req.param("dbRootId");
  const tableName = c.req.param("tableName");
  const network = c.get("network");

  return streamSSE(c, async (stream) => {
    const k = subKey(network, dbRootId, tableName);
    let set = subscribers.get(k);
    if (!set) { set = new Set(); subscribers.set(k, set); }
    set.add(stream);

    await stream.writeSSE({ event: "hello", data: JSON.stringify({ dbRootId, tableName, network }) });
    try {
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (stream.aborted) break;
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    } finally {
      set.delete(stream);
      if (set.size === 0) subscribers.delete(k);
    }
  });
});

// ─── /table/:dbRootId/:feedName/thread/:threadName ──────────────────────────

function pickOp<T extends { sub?: unknown; time?: unknown; threadSeed?: unknown }>(
  candidates: T[],
): T | undefined {
  return candidates.reduce<T | undefined>((best, r) => {
    if (!r.threadSeed) return best;
    if (!best) return r;
    const bHasSub = !!best.sub;
    const rHasSub = !!r.sub;
    if (rHasSub !== bHasSub) return rHasSub ? r : best;
    return (r.time as number ?? 0) < (best.time as number ?? 0) ? r : best;
  }, undefined);
}

tableRouter.get("/:dbRootId/:feedName/thread/:threadName", async (c) => {
  const dbRootId = c.req.param("dbRootId");
  const feedName = c.req.param("feedName");
  const threadName = c.req.param("threadName");
  const chain = c.get("chain");
  const network = c.get("network");
  const replyLimit = Math.min(Number(c.req.query("replyLimit")) || 100, 500);
  const feedScan = Math.min(Number(c.req.query("feedScan")) || 100, 500);

  const key = cacheKey(network, "thread", dbRootId, feedName, threadName, String(replyLimit), String(feedScan));

  async function fetchThread(): Promise<RowsCacheEntry> {
    const [feedRows, threadRows] = await Promise.all([
      chain.readTableRows(dbRootId, feedName, { limit: feedScan }),
      chain.readTableRows(dbRootId, threadName, { limit: replyLimit }),
    ]);

    const feedForThread = feedRows.filter(
      (r) => (r as { threadName?: string }).threadName === threadName,
    );
    const op = pickOp(feedForThread as Array<Record<string, unknown>>)
      ?? pickOp(threadRows as Array<Record<string, unknown>>)
      ?? null;

    const opTx = (op as { __txHash?: string } | null)?.__txHash;
    const replies = threadRows
      .filter((r) => (r as { __txHash?: string }).__txHash !== opTx)
      .sort((a, b) => ((a as { time?: number }).time ?? 0) - ((b as { time?: number }).time ?? 0));

    const json = JSON.stringify({
      dbRootId, feedName, threadName,
      op, replies, totalReplies: replies.length,
    });
    const entry: RowsCacheEntry = { json };
    rowsCache.set(key, entry, HEAD_TTL);
    return entry;
  }

  const mem = rowsCache.get(key);
  if (mem) {
    if (shouldRefresh(key)) deduped(inflight, key, fetchThread).catch(() => {});
    return respondWithEtag(c, { ...JSON.parse(mem.json), cached: true }, etagFor(mem.json));
  }

  try {
    const entry = await deduped(inflight, key, fetchThread);
    return respondWithEtag(c, { ...JSON.parse(entry.json), cached: false }, etagFor(entry.json));
  } catch (e) {
    console.error(`[thread] failed:`, e instanceof Error ? e.message : e);
    return c.json({ error: "failed to read thread" }, 500);
  }
});

// ─── /table/:dbRootId/:tableName/index ───────────────────────────────────────

const INDEX_TTL = 2 * 60 * 1000;
const INDEX_MAX_ROWS = 10000;

tableRouter.get("/:dbRootId/:tableName/index", async (c) => {
  const dbRootId = c.req.param("dbRootId");
  const tableName = c.req.param("tableName");
  const chain = c.get("chain");
  const network = c.get("network");
  const key = cacheKey(network, "index", dbRootId, tableName);

  async function fetchIndex(): Promise<string> {
    const rows = await chain.readTableRows(dbRootId, tableName, { limit: INDEX_MAX_ROWS });
    const txHashes = rows.map((r) => (r as { __txHash?: string }).__txHash).filter(Boolean);
    const json = JSON.stringify({ dbRootId, tableName, txHashes, total: txHashes.length });
    indexCache.set(key, json, INDEX_TTL);
    setDiskCache("rows", key, json, network).catch(() => {});
    return json;
  }

  const mem = indexCache.get(key);
  if (mem) return c.json({ ...JSON.parse(mem), cached: true });

  const disk = await getDiskCache("rows", key, network);
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
    if (message.includes("Table not found")) return c.json({ error: "table not found" }, 404);
    console.error("[table/index] failed:", message);
    return c.json({ error: "failed to fetch index" }, 500);
  }
});

// ─── /table/:dbRootId/:tableName/slice ───────────────────────────────────────

const SLICE_MAX = 50;

tableRouter.get("/:dbRootId/:tableName/slice", async (c) => {
  const dbRootId = c.req.param("dbRootId");
  const tableName = c.req.param("tableName");
  const chain = c.get("chain");
  const network = c.get("network");
  const sigsParam = c.req.query("sigs") || c.req.query("txHashes");
  if (!sigsParam) return c.json({ error: "sigs query parameter required" }, 400);

  const hashes = sigsParam.split(",").filter(Boolean);
  if (hashes.length === 0) return c.json({ error: "no tx hashes provided" }, 400);
  if (hashes.length > SLICE_MAX) return c.json({ error: `max ${SLICE_MAX} hashes per request` }, 400);
  for (const h of hashes) if (!isTxHash(h)) return c.json({ error: `invalid tx hash: ${h}` }, 400);

  const key = cacheKey(network, "slice", dbRootId, tableName, ...hashes);

  async function fetchSlice(): Promise<string> {
    const rows: Row[] = [];
    const uncached: string[] = [];

    for (const h of hashes) {
      const rowKey = cacheKey(network, "row", h);
      const mem = sliceCache.get(rowKey);
      if (mem) {
        if (mem !== "null") rows.push(JSON.parse(mem));
        continue;
      }
      const disk = await getDiskCache("meta", rowKey, network);
      if (disk) {
        const json = disk.toString("utf8");
        sliceCache.set(rowKey, json, SLICE_ROW_TTL);
        if (json !== "null") rows.push(JSON.parse(json));
        continue;
      }
      uncached.push(h);
    }

    for (const h of uncached) {
      const row = await chain.readSingleRow(h).catch(() => null);
      const rowKey = cacheKey(network, "row", h);
      if (row) {
        const rowJson = JSON.stringify(row);
        sliceCache.set(rowKey, rowJson, SLICE_ROW_TTL);
        setDiskCache("meta", rowKey, rowJson, network).catch(() => {});
        rows.push(row);
      } else {
        sliceCache.set(rowKey, "null", SLICE_ROW_TTL);
      }
    }

    const order = new Map(hashes.map((s, i) => [s, i]));
    rows.sort((a, b) => {
      const aIdx = order.get((a as { __txHash?: string }).__txHash || "") ?? 999;
      const bIdx = order.get((b as { __txHash?: string }).__txHash || "") ?? 999;
      return aIdx - bIdx;
    });

    return JSON.stringify({ dbRootId, tableName, rows, count: rows.length });
  }

  try {
    const json = await deduped(inflight, key, fetchSlice);
    return c.json({ ...JSON.parse(json), cached: false });
  } catch (e) {
    console.error("[table/slice] failed:", e instanceof Error ? e.message : e);
    return c.json({ error: "failed to decode rows" }, 500);
  }
});

// ─── /table/:dbRootId/:tableName/meta ────────────────────────────────────────

tableRouter.get("/:dbRootId/:tableName/meta", async (c) => {
  const dbRootId = c.req.param("dbRootId");
  const tableName = c.req.param("tableName");
  const chain = c.get("chain");
  try {
    const meta = await chain.getTableMetaCached(dbRootId, tableName);
    if (!meta) return c.json({ error: "table not found" }, 404);
    return c.json(meta);
  } catch {
    return c.json({ error: "failed to decode table" }, 500);
  }
});

// ─── POST /table/:dbRootId/:tableName/notify ─────────────────────────────────

tableRouter.post("/:dbRootId/:tableName/notify", async (c) => {
  const dbRootId = c.req.param("dbRootId");
  const tableName = c.req.param("tableName");
  const chain = c.get("chain");
  const network = c.get("network");
  const body = await c.req.json().catch(() => null);
  const txHash: string | undefined = body?.txHash || body?.txSignature;
  const rowData = body?.row;
  const signer: string | undefined = body?.signer;

  if (typeof signer === "string" && isEvmAddress(signer)) invalidateUserAssets(signer);

  if (!txHash || !isTxHash(txHash)) return c.json({ error: "valid txHash required" }, 400);

  const row = rowData
    ? {
        ...rowData,
        __txHash: txHash,
        ...(typeof signer === "string" && !rowData.__signer ? { __signer: signer } : {}),
      }
    : await chain.readSingleRow(txHash).catch(() => null);

  if (!row) {
    for (const limit of [50, 100, 20, 10, 5]) {
      const key = cacheKey(network, dbRootId, tableName, String(limit), "");
      rowsCache.delete(key);
      lastRefresh.delete(key);
    }
    return c.json({ ok: true, cached: false });
  }

  const rowJson = JSON.stringify(row);
  const rowKey = cacheKey(network, "row", txHash);
  sliceCache.set(rowKey, rowJson, SLICE_ROW_TTL);
  setDiskCache("meta", rowKey, rowJson, network).catch(() => {});

  for (const limit of [50, 100, 20, 10, 5]) {
    const key = cacheKey(network, dbRootId, tableName, String(limit), "");
    const existing = rowsCache.get(key);
    if (!existing || !existing.rows) continue;
    if (existing.rows.some((r) => (r as { __txHash?: string }).__txHash === txHash)) continue;
    existing.rows.unshift(row);
    existing.rows = existing.rows.slice(0, limit);
    existing.json = JSON.stringify(buildRowsResponse(dbRootId, tableName, existing.rows, limit, undefined));
    rowsCache.set(key, existing, HEAD_TTL);
  }

  const now = Date.now();
  for (const limit of [50, 100, 20, 10, 5]) {
    lastRefresh.set(cacheKey(network, dbRootId, tableName, String(limit), ""), now);
  }

  publishToSubscribers(network, dbRootId, tableName, row);

  (async () => {
    try {
      await ingestRow({ row, txHash, dbrootLabel: dbRootId, tableLabel: tableName, network });
    } catch {}
  })();

  return c.json({ ok: true, cached: true });
});

// ─── /table/dbroot ───────────────────────────────────────────────────────────
// Single-dbroot inspector; ?id= so any dbRootId can be inspected.

const dbrootSingleCache = new MemoryCache<string>(20);
const DBROOT_TTL = 5 * 60 * 1000;

tableRouter.get("/dbroot", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id query parameter required" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");
  const cacheKeyStr = `${network}:dbroot:${id}`;
  const cached = dbrootSingleCache.get(cacheKeyStr);
  if (cached) return c.json(JSON.parse(cached));

  try {
    const root = await chain.getTablelistFromRoot(id);
    const result = {
      id,
      creator: root.creator ?? null,
      tables: root.tables,
      globalTables: root.globalTables,
      tableCreationFeeOverride: root.tableCreationFeeOverride.toString(),
      tableCreationFeeIsSet: root.tableCreationFeeIsSet,
    };
    const json = JSON.stringify(result);
    dbrootSingleCache.set(cacheKeyStr, json, DBROOT_TTL);
    return c.json(result);
  } catch (e) {
    console.error("[dbroot] failed:", e instanceof Error ? e.message : e);
    return c.json({ error: "failed to read dbRoot" }, 500);
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
