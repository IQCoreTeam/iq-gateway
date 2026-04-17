import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { createHash } from "node:crypto";
import iqlabs from "@iqlabs-official/solana-sdk";
import { fetchSignatureIndex, readRowsBySignatures, fetchRecentSignatures, readMultipleRows, readSingleRow, getTableMetaCached } from "../chain";
import { MemoryCache, TTL, getDiskCache, setDiskCache, deduped } from "../cache";
import { invalidateUserAssets } from "./user";
import { isValidPublicKey } from "../utils";

export const tableRouter = new Hono();

const rowsCache = new MemoryCache<string>(500);
const indexCache = new MemoryCache<string>(50);
const sliceCache = new MemoryCache<string>(2000);

const inflight = new Map<string, Promise<string>>();

function cacheKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 24);
}

/** Weak ETag derived from the cached JSON body. Stable across cache hits
 *  (doesn't depend on the `cached` envelope flag). */
function etagFor(json: string): string {
  return `W/"${createHash("sha256").update(json).digest("hex").slice(0, 16)}"`;
}

/** 304 on If-None-Match, otherwise set the ETag header and return the body.
 *  Used by any endpoint that wants conditional GET on its JSON response. */
function respondWithEtag(c: Context, body: Record<string, unknown>, etag: string): Response {
  if (c.req.header("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  c.header("ETag", etag);
  return c.json(body);
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

/**
 * Given a signature list, return the corresponding rows in signature order.
 * Checks memory cache → disk cache → RPC, fills each tier going back, and
 * records null-rows (non-row sigs like table creation) so we don't refetch.
 * Shared by /rows and /thread so the per-sig cache works across both.
 */
async function resolveRowsFromSignatures(signatures: string[]): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const uncached: string[] = [];

  for (const sig of signatures) {
    const rowKey = cacheKey("row", sig);
    const mem = sliceCache.get(rowKey);
    if (mem) {
      if (mem !== "null") rows.push(JSON.parse(mem));
      continue;
    }
    const disk = await getDiskCache("meta", rowKey);
    if (disk) {
      const json = disk.toString("utf8");
      sliceCache.set(rowKey, json, SLICE_ROW_TTL);
      if (json !== "null") rows.push(JSON.parse(json));
      continue;
    }
    uncached.push(sig);
  }

  if (uncached.length > 0) {
    const fetched = await readMultipleRows(uncached);
    for (const sig of uncached) {
      const row = fetched.get(sig) ?? null;
      const rowKey = cacheKey("row", sig);
      if (row) {
        const txSig = (row as { __txSignature?: string }).__txSignature || sig;
        const rowJson = JSON.stringify(row);
        const rk = cacheKey("row", txSig);
        sliceCache.set(rk, rowJson, SLICE_ROW_TTL);
        setDiskCache("meta", rk, rowJson).catch(() => {});
        rows.push(row);
      } else {
        sliceCache.set(rowKey, "null", SLICE_ROW_TTL);
      }
    }
  }

  const sigOrder = new Map(signatures.map((s, i) => [s, i]));
  rows.sort((a, b) => {
    const aIdx = sigOrder.get((a as { __txSignature?: string }).__txSignature || "") ?? 999;
    const bIdx = sigOrder.get((b as { __txSignature?: string }).__txSignature || "") ?? 999;
    return aIdx - bIdx;
  });
  return rows;
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
  const isHead = !before;
  const ttl = isHead ? HEAD_TTL : TTL.ROWS;

  async function fetchRows(): Promise<string> {
    const signatures = await fetchRecentSignatures(tablePda, limit, before);
    const rows = await resolveRowsFromSignatures(signatures);
    const json = JSON.stringify(buildRowsResponse(tablePda, rows, limit, before));
    rowsCache.set(key, json, ttl);
    if (rows.length > 0) setDiskCache("rows", key, json).catch(() => {});
    console.log(`[rows] ${tablePda.slice(0,8)} sigs=${signatures.length} rows=${rows.length}`);
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
      return respondWithEtag(c, { ...JSON.parse(mem), cached: true }, etagFor(mem));
    }

    // Disk cache hit — serve immediately, no background refresh
    // (memory cache will expire, triggering a fresh fetch next time)
    const disk = await getDiskCache("rows", key);
    if (disk) {
      const json = disk.toString("utf8");
      rowsCache.set(key, json, ttl);
      return respondWithEtag(c, { ...JSON.parse(json), cached: true }, etagFor(json));
    }
  }

  try {
    const json = await deduped(inflight, key, fetchRows);
    return respondWithEtag(c, { ...JSON.parse(json), cached: false }, etagFor(json));
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
      return respondWithEtag(c, { ...JSON.parse(json), cached: true }, etagFor(json));
    }
    console.error(`[table] failed to read ${tablePda}:`, message);
    return c.json({ error: "failed to read table" }, 500);
  }
});

// ─── /table/:tablePda/subscribe (SSE) ────────────────────────────────────────
// Live stream of new rows for a table PDA. When /notify fires for the same
// PDA, every open subscriber receives an SSE event. Clients listen via the
// browser-native EventSource API and `refresh()` on each message — replaces
// the client-side polling loop in thread/board views.

const subscribers = new Map<string, Set<SSEStreamingApi>>();

/** Publish a new row to every open SSE stream for this PDA. Silent on failure
 *  (a dead stream shouldn't break /notify for others). */
function publishToSubscribers(tablePda: string, row: Record<string, unknown>): void {
  const set = subscribers.get(tablePda);
  if (!set || set.size === 0) return;
  const data = JSON.stringify({ row });
  for (const stream of set) {
    stream.writeSSE({ event: "row", data }).catch(() => {});
  }
}

tableRouter.get("/:tablePda/subscribe", (c) => {
  const tablePda = c.req.param("tablePda");
  if (!isValidPublicKey(tablePda)) return c.json({ error: "invalid table PDA" }, 400);

  return streamSSE(c, async (stream) => {
    let set = subscribers.get(tablePda);
    if (!set) { set = new Set(); subscribers.set(tablePda, set); }
    set.add(stream);

    await stream.writeSSE({ event: "hello", data: JSON.stringify({ tablePda }) });
    try {
      // Heartbeat every 30s keeps proxies from dropping idle streams. Loop
      // exits when the client disconnects (stream.aborted flips true).
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (stream.aborted) break;
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    } finally {
      set.delete(stream);
      if (set.size === 0) subscribers.delete(tablePda);
    }
  });
});

// ─── /table/:feedPda/thread/:threadPda ───────────────────────────────────────
// One call returns {op, replies, totalReplies} — moves iq-chan's OP-picker
// logic server-side so the client makes a single request instead of two.
// feedPda is the board-scoped feed table; threadPda is the thread's own table.

/**
 * Pick the canonical OP out of a candidate list. Mirrors iq-chan's isMoreLikelyOp:
 * prefer rows with non-empty `sub` (OPs have a subject, reply-bumps hardcode ""),
 * tiebreak by earliest time (OP is posted before its replies).
 */
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

tableRouter.get("/:feedPda/thread/:threadPda", async (c) => {
  const feedPda = c.req.param("feedPda");
  const threadPda = c.req.param("threadPda");
  const replyLimit = Math.min(Number(c.req.query("replyLimit")) || 100, 500);
  const feedScan = Math.min(Number(c.req.query("feedScan")) || 100, 500);

  if (!isValidPublicKey(feedPda) || !isValidPublicKey(threadPda)) {
    return c.json({ error: "invalid PDA" }, 400);
  }

  const key = cacheKey("thread", feedPda, threadPda, String(replyLimit), String(feedScan));

  async function fetchThread(): Promise<string> {
    const [feedSigs, threadSigs] = await Promise.all([
      fetchRecentSignatures(feedPda, feedScan),
      fetchRecentSignatures(threadPda, replyLimit),
    ]);
    const [feedRows, threadRows] = await Promise.all([
      resolveRowsFromSignatures(feedSigs),
      resolveRowsFromSignatures(threadSigs),
    ]);

    const feedForThread = feedRows.filter(
      (r) => (r as { threadPda?: string }).threadPda === threadPda,
    );
    const op = pickOp(feedForThread as Array<Record<string, unknown>>)
      ?? pickOp(threadRows as Array<Record<string, unknown>>)
      ?? null;

    const opSig = (op as { __txSignature?: string } | null)?.__txSignature;
    const replies = threadRows
      .filter((r) => (r as { __txSignature?: string }).__txSignature !== opSig)
      .sort((a, b) => ((a as { time?: number }).time ?? 0) - ((b as { time?: number }).time ?? 0));

    const body = {
      threadPda,
      feedPda,
      op,
      replies,
      totalReplies: replies.length,
    };
    const json = JSON.stringify(body);
    rowsCache.set(key, json, HEAD_TTL);
    console.log(`[thread] ${threadPda.slice(0, 8)} op=${!!op} replies=${replies.length}`);
    return json;
  }

  const mem = rowsCache.get(key);
  if (mem) {
    if (shouldRefresh(key)) deduped(inflight, key, fetchThread).catch(() => {});
    return respondWithEtag(c, { ...JSON.parse(mem), cached: true }, etagFor(mem));
  }

  try {
    const json = await deduped(inflight, key, fetchThread);
    return respondWithEtag(c, { ...JSON.parse(json), cached: false }, etagFor(json));
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    console.error(`[thread] failed for ${threadPda}:`, message);
    return c.json({ error: "failed to read thread" }, 500);
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
      const disk = await getDiskCache("meta", rowKey);
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
          setDiskCache("meta", rowKey, rowJson).catch(() => {});
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

// ─── POST /table/:tablePda/notify ────────────────────────────────────────────
// Frontend calls this after posting a tx. Gateway fetches that one row,
// prepends it to the cached rows response so the next /rows request includes
// it immediately — even before the RPC indexes the new signature.

tableRouter.post("/:tablePda/notify", async (c) => {
  const tablePda = c.req.param("tablePda");
  const body = await c.req.json().catch(() => null);
  const txSig = body?.txSignature;
  const rowData = body?.row;
  const signer = body?.signer;

  // Drop the writer's cached assets list so their next /user/.../assets
  // call returns the new note instead of stale cache.
  if (typeof signer === "string") invalidateUserAssets(signer);

  if (!txSig || typeof txSig !== "string") {
    return c.json({ error: "txSignature required" }, 400);
  }

  if (!isValidPublicKey(tablePda)) {
    return c.json({ error: "invalid table PDA" }, 400);
  }

  // Use row data from frontend if provided, otherwise try fetching from chain.
  // Client sends a top-level `signer` for user-asset invalidation — reuse it to
  // stamp __signer on the row so clients don't have to populate it twice.
  const row = rowData
    ? {
        ...rowData,
        __txSignature: txSig,
        ...(typeof signer === "string" && !rowData.__signer ? { __signer: signer } : {}),
      }
    : await readSingleRow(txSig).catch(() => null);

  if (!row) {
    // Even if we can't get the row, invalidate cache so next fetch is fresh
    for (const limit of [50, 100, 20, 10, 5]) {
      const key = cacheKey(tablePda, String(limit), "");
      rowsCache.delete(key);
      lastRefresh.delete(key);
    }
    console.log(`[notify] ${tablePda.slice(0, 12)}… tx:${txSig.slice(0, 12)}… invalidated (row not available)`);
    return c.json({ ok: true, cached: false });
  }

  // Cache the individual row
  const rowJson = JSON.stringify(row);
  const rowKey = cacheKey("row", txSig);
  sliceCache.set(rowKey, rowJson, SLICE_ROW_TTL);
  setDiskCache("meta", rowKey, rowJson).catch(() => {});

  // Prepend row to all cached head-page responses for this table
  for (const limit of [50, 100, 20, 10, 5]) {
    const key = cacheKey(tablePda, String(limit), "");
    const existing = rowsCache.get(key);
    if (!existing) continue;
    const parsed = JSON.parse(existing);
    const rows: Record<string, unknown>[] = parsed.rows ?? [];
    if (rows.some((r: Record<string, unknown>) => r.__txSignature === txSig)) continue;
    rows.unshift(row);
    const updated = JSON.stringify({ ...parsed, rows, count: rows.length });
    rowsCache.set(key, updated, HEAD_TTL);
  }

  // Set refresh timestamp to NOW so background refresh doesn't overwrite
  // the injected cache for 30s (gives RPC time to index the new sig)
  const now = Date.now();
  for (const limit of [50, 100, 20, 10, 5]) {
    lastRefresh.set(cacheKey(tablePda, String(limit), ""), now);
  }

  publishToSubscribers(tablePda, row);

  console.log(`[notify] ${tablePda.slice(0, 12)}… tx:${txSig.slice(0, 12)}… injected`);
  return c.json({ ok: true, cached: true });
});

// ─── /table/:tablePda/meta ───────────────────────────────────────────────────

import { contract } from "@iqlabs-official/solana-sdk";
const accountCoder = new BorshAccountsCoder(contract.IQ_IDL);
const metaRpc = new Connection(
  process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
);

tableRouter.get("/:tablePda/meta", async (c) => {
  const tablePda = c.req.param("tablePda");
  if (!isValidPublicKey(tablePda)) return c.json({ error: "invalid PDA" }, 400);

  try {
    const meta = await getTableMetaCached(tablePda);
    if (!meta) return c.json({ error: "account not found" }, 404);
    return c.json(meta);
  } catch {
    return c.json({ error: "failed to decode table" }, 500);
  }
});

// ─── /dbroot ─────────────────────────────────────────────────────────────────
// Returns table_seeds, global_table_seeds, creator, and table_creators from the
// on-chain DbRoot account. Cached 5 min. Eliminates direct RPC from the frontend.

const dbrootCache = new MemoryCache<string>(10);
const DBROOT_TTL = 5 * 60 * 1000;

const DB_ROOT_ID = "iqchan";

tableRouter.get("/dbroot", async (c) => {
  const key = "dbroot:" + DB_ROOT_ID;
  const cached = dbrootCache.get(key);
  if (cached) return c.json(JSON.parse(cached));

  try {
    const dbRootSeed = iqlabs.utils.toSeedBytes(DB_ROOT_ID);
    const dbRootKey = iqlabs.contract.getDbRootPda(Buffer.from(dbRootSeed));

    const info = await metaRpc.getAccountInfo(dbRootKey);
    if (!info) return c.json({ error: "DbRoot not found" }, 404);

    const decoded = accountCoder.decode("DbRoot", info.data) as any;

    const toHex = (v: any): string => {
      if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
      if (Array.isArray(v)) return Buffer.from(v).toString("hex");
      if (v?.data && Array.isArray(v.data)) return Buffer.from(v.data).toString("hex");
      return "";
    };

    const rawTableSeeds = decoded.table_seeds ?? decoded.tableSeeds ?? [];
    const rawGlobalSeeds = decoded.global_table_seeds ?? decoded.globalTableSeeds ?? [];
    const rawCreators = decoded.table_creators ?? [];

    const globalHexes = rawGlobalSeeds.map(toHex);

    // Batch-fetch table names for all global seeds (server-side, avoids N client requests)
    const tableNames: Record<string, string> = {};
    await Promise.allSettled(
      globalHexes.map(async (hex: string) => {
        try {
          const seedBytes = Buffer.from(hex, "hex");
          const tablePda = iqlabs.contract.getTablePda(dbRootKey, seedBytes);
          const tInfo = await metaRpc.getAccountInfo(tablePda);
          if (tInfo) {
            const tDecoded = accountCoder.decode("Table", tInfo.data) as any;
            const raw = tDecoded.name;
            const toBuf = (v: any) => Buffer.isBuffer(v) ? v : Buffer.from(v?.data ?? v ?? []);
            const name = toBuf(raw).toString("utf8").replace(/\0/g, "");
            if (name) tableNames[hex] = name;
          }
        } catch { /* not a valid table account */ }
      }),
    );

    const result = {
      creator: decoded.creator ? new PublicKey(decoded.creator).toBase58() : null,
      tableSeeds: rawTableSeeds.map(toHex),
      globalTableSeeds: globalHexes,
      tableCreators: rawCreators.map((pk: any) =>
        pk instanceof PublicKey ? pk.toBase58() : new PublicKey(pk).toBase58()
      ),
      tableNames,
    };

    const json = JSON.stringify(result);
    dbrootCache.set(key, json, DBROOT_TTL);
    return c.json(result);
  } catch (e) {
    console.error("[dbroot] failed:", e instanceof Error ? e.message : e);
    return c.json({ error: "failed to read DbRoot" }, 500);
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
