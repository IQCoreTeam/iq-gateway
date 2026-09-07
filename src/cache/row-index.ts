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
