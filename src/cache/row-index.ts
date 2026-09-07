// Durable EVM row index — the gateway's layer-2 database for EVM tables.
//
// EVM has no getSignaturesForAddress: enumerating a table's rows means a
// strictly sequential walk of beforeDataTx pointers (one RPC round-trip per
// row, redone on every cold cache), and rows orphaned by the two-tx writeRow
// race (dbCodeIn landed, updateTableTxChainTail lost) fall off that walk
// entirely. This module fixes both: a durable SQLite index of every row-write
// tx seen for a (network, dbroot, table), fed by three sources:
//   1. live reads     — readTableRows/readSingleRow results are recorded
//   2. /notify        — write-through from posting clients
//   3. log backfill   — eth_getLogs(DbCodeInEvent) scans, see
//                       chain/evm/log-index.ts
//
// Lives in cache.db alongside the LRU store but, like catalog_fts, is NEVER
// pruned: tx enumeration is chain-truth. row_json is a hydration cache for the
// payload; a missing row_json is refetched on serve, the "null" sentinel marks
// a tx confirmed non-decodable so it is not refetched forever.

import type { Database } from "bun:sqlite";
import { getDb } from "./store";

export interface RowIndexEntry {
  network: string;
  dbroot: string;
  tableName: string;
  txHash: string;
  blockNumber?: number | null;
  logIndex?: number | null;
  blockTime?: number | null;
  signer?: string | null;
  rowJson?: string | null;
}

export interface IndexedRow {
  tx_hash: string;
  block_number: number | null;
  log_index: number | null;
  block_time: number | null;
  signer: string | null;
  row_json: string | null;
}

export interface IndexState {
  syncedFromBlock: number;
  syncedToBlock: number;
  complete: boolean;
}

/** Hard cap on rows pulled into memory when resolving a `before` cursor. */
const INDEX_HARD_CAP = 50_000;

let prepared = false;

function prepare(db: Database): void {
  if (prepared) return;
  db.run(`
    CREATE TABLE IF NOT EXISTS evm_row_index (
      network TEXT NOT NULL,
      dbroot TEXT NOT NULL,
      table_name TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_number INTEGER,
      log_index INTEGER,
      block_time INTEGER,
      signer TEXT,
      row_json TEXT,
      ingested_at INTEGER NOT NULL,
      PRIMARY KEY (network, dbroot, table_name, tx_hash)
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_evm_row_order
    ON evm_row_index(network, dbroot, table_name, block_number DESC)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS evm_index_state (
      network TEXT NOT NULL,
      dbroot TEXT NOT NULL,
      table_name TEXT NOT NULL,
      synced_from_block INTEGER NOT NULL,
      synced_to_block INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (network, dbroot, table_name)
    )
  `);
  prepared = true;
}

/** Batch upsert. New facts fill gaps but never blank out known ones: an
 *  entry from a log scan (no payload) won't erase a row_json hydrated
 *  earlier, and a live read (no log_index) won't erase the log position. */
export async function recordRows(entries: RowIndexEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  prepare(db);
  const stmt = db.prepare(`
    INSERT INTO evm_row_index
      (network, dbroot, table_name, tx_hash, block_number, log_index, block_time, signer, row_json, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(network, dbroot, table_name, tx_hash) DO UPDATE SET
      block_number = COALESCE(excluded.block_number, block_number),
      log_index    = COALESCE(excluded.log_index, log_index),
      block_time   = COALESCE(excluded.block_time, block_time),
      signer       = COALESCE(excluded.signer, signer),
      row_json     = COALESCE(excluded.row_json, row_json)
  `);
  const now = Date.now();
  db.transaction((rows: RowIndexEntry[]) => {
    for (const r of rows) {
      stmt.run(
        r.network, r.dbroot, r.tableName, r.txHash,
        r.blockNumber ?? null, r.logIndex ?? null, r.blockTime ?? null,
        r.signer ?? null, r.rowJson ?? null, now,
      );
    }
  })(entries);
}

// Newest first: rows with no block yet (fresh /notify injections) sort on top,
// then by block descending, log position descending, ingest order descending.
const ORDER_SQL = `
  ORDER BY (block_number IS NULL) DESC, block_number DESC,
           (log_index IS NULL) DESC, log_index DESC,
           ingested_at DESC, rowid DESC
`;

/** Keyset page, newest first. Unknown/absent `before` serves from the head
 *  (mirrors the walk-based path). */
export async function listIndexedRows(
  network: string, dbroot: string, tableName: string,
  opts: { limit: number; before?: string },
): Promise<IndexedRow[]> {
  const db = await getDb();
  prepare(db);
  const base = `
    SELECT tx_hash, block_number, log_index, block_time, signer, row_json
    FROM evm_row_index
    WHERE network = ? AND dbroot = ? AND table_name = ?
    ${ORDER_SQL}
  `;
  if (!opts.before) {
    return db.query<IndexedRow, [string, string, string, number]>(`${base} LIMIT ?`)
      .all(network, dbroot, tableName, opts.limit);
  }
  const all = db.query<IndexedRow, [string, string, string, number]>(`${base} LIMIT ?`)
    .all(network, dbroot, tableName, INDEX_HARD_CAP);
  const at = all.findIndex((r) => r.tx_hash === opts.before);
  const start = at >= 0 ? at + 1 : 0;
  return all.slice(start, start + opts.limit);
}

// ─── Derived bump feed ───────────────────────────────────────────────────────
// EVM has no feed PDA, so "which thread was bumped most recently" is not written
// on chain — it is derived here from the durable index. A thread's activity is
// the latest block across its OP (written to the board table) and its replies
// (written to its own table, named "<board>-thread-<uuid>" by the client). This
// is pure chain-truth: anyone can recompute it from eth_getLogs, no lock-in.
//
// v1 limits (noted, not yet applied): sage replies still bump; bump does not
// freeze past BUMP_LIMIT. Both need per-row payload parsing and can be layered
// on later without changing this signature.

export interface ThreadFeedEntry {
  threadName: string;
  op: Record<string, unknown> | null;
  replyCount: number;
  lastActivityTime: number | null;
  lastBlock: number | null;
}

/** Cap on board OP rows scanned per feed request (one OP per thread). */
const FEED_OP_SCAN_CAP = 5000;

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
// null block = a just-posted row not yet stamped with a block; sort it on top.
const bumpKey = (b: number | null) => (b === null ? Number.MAX_SAFE_INTEGER : b);

export async function listThreadFeed(
  network: string, dbroot: string, board: string, limit: number,
): Promise<ThreadFeedEntry[]> {
  const db = await getDb();
  prepare(db);

  // 1. Board OPs — one row per thread, carrying the OP payload + threadPda.
  const opRows = db.query<IndexedRow, [string, string, string, number]>(`
    SELECT tx_hash, block_number, log_index, block_time, signer, row_json
    FROM evm_row_index
    WHERE network = ? AND dbroot = ? AND table_name = ?
    ${ORDER_SQL} LIMIT ?
  `).all(network, dbroot, board, FEED_OP_SCAN_CAP);

  const threads = new Map<string, { op: Record<string, unknown>; opBlock: number | null; opTime: number | null }>();
  for (const r of opRows) {
    if (!r.row_json) continue;
    let op: Record<string, unknown>;
    try { op = JSON.parse(r.row_json); } catch { continue; }
    const threadName = (op.threadPda ?? op.threadSeed) as string | undefined;
    if (!threadName || typeof threadName !== "string") continue;
    const hasSub = !!op.sub;
    const existing = threads.get(threadName);
    // One OP per thread; if duplicates appear, prefer the row that looks like
    // the OP (non-empty sub).
    if (!existing || (hasSub && !existing.op.sub)) {
      threads.set(threadName, {
        op,
        opBlock: r.block_number ?? null,
        opTime: r.block_time ?? (typeof op.time === "number" ? op.time : null),
      });
    }
  }
  if (threads.size === 0) return [];

  // 2. Per-thread activity from the thread tables ("<board>-thread-%").
  const activity = db.query<{ table_name: string; mb: number | null; mt: number | null; cnt: number }, [string, string, string]>(`
    SELECT table_name, MAX(block_number) AS mb, MAX(block_time) AS mt, COUNT(*) AS cnt
    FROM evm_row_index
    WHERE network = ? AND dbroot = ? AND table_name LIKE ?
    GROUP BY table_name
  `).all(network, dbroot, `${board}-thread-%`);
  const actMap = new Map(activity.map((a) => [a.table_name, a]));

  // 3. Merge + bump sort.
  const out: ThreadFeedEntry[] = [];
  for (const [threadName, t] of threads) {
    const a = actMap.get(threadName);
    out.push({
      threadName,
      op: t.op,
      replyCount: a?.cnt ?? 0,
      lastActivityTime: maxNullable(t.opTime, a?.mt ?? null),
      lastBlock: maxNullable(t.opBlock, a?.mb ?? null),
    });
  }
  out.sort((x, y) => bumpKey(y.lastBlock) - bumpKey(x.lastBlock));
  return out.slice(0, limit);
}

export async function countIndexedRows(network: string, dbroot: string, tableName: string): Promise<number> {
  const db = await getDb();
  prepare(db);
  const r = db.query<{ n: number }, [string, string, string]>(
    "SELECT COUNT(*) AS n FROM evm_row_index WHERE network = ? AND dbroot = ? AND table_name = ?",
  ).get(network, dbroot, tableName);
  return r?.n ?? 0;
}

export async function getIndexState(network: string, dbroot: string, tableName: string): Promise<IndexState | null> {
  const db = await getDb();
  prepare(db);
  const r = db.query<{ synced_from_block: number; synced_to_block: number; complete: number }, [string, string, string]>(
    "SELECT synced_from_block, synced_to_block, complete FROM evm_index_state WHERE network = ? AND dbroot = ? AND table_name = ?",
  ).get(network, dbroot, tableName);
  if (!r) return null;
  return { syncedFromBlock: r.synced_from_block, syncedToBlock: r.synced_to_block, complete: !!r.complete };
}

export async function setIndexState(
  network: string, dbroot: string, tableName: string, state: IndexState,
): Promise<void> {
  const db = await getDb();
  prepare(db);
  db.run(
    `INSERT OR REPLACE INTO evm_index_state
       (network, dbroot, table_name, synced_from_block, synced_to_block, complete, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [network, dbroot, tableName, state.syncedFromBlock, state.syncedToBlock, state.complete ? 1 : 0, Date.now()],
  );
}

export async function rowIndexStats(): Promise<{ rows: number; tables: number; backfilledTables: number }> {
  const db = await getDb();
  prepare(db);
  const rows = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM evm_row_index").get()?.n ?? 0;
  const tables = db.query<{ n: number }, []>(
    "SELECT COUNT(DISTINCT network || ':' || dbroot || ':' || table_name) AS n FROM evm_row_index",
  ).get()?.n ?? 0;
  const backfilledTables = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM evm_index_state WHERE complete = 1",
  ).get()?.n ?? 0;
  return { rows, tables, backfilledTables };
}
