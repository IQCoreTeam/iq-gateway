// Catalog search index.
//
// Lives in the same SQLite file (cache.db) as the cache LRU store but in its
// own virtual table so cache eviction doesn't drop search results — once a
// row is on chain it's chain-truth and should stay searchable forever.
//
// Indexes inline text of inscriptions only:
//   - dbroot labels
//   - table hint labels
//   - row payload text fields (com, sub, name, content, message, body, ...)
//     plus metadata.filename / metadata.ext as breadcrumbs for chunked assets
//
// FTS5 trigram tokenizer — works well for short ids, mixed-language strings,
// and prefix matches (Google-style "type as you go").

import type { Database } from "bun:sqlite";
import { getDb } from "./store";

export interface CatalogEntry {
  kind: "dbroot" | "table" | "row";
  id: string;        // pda for dbroot/table, tx signature for row
  dbroot: string;    // dbroot label or pda, "" if not applicable
  label: string;     // short display name shown on the result card
  snippet: string;   // longer one-line preview
  body: string;      // full text we want searchable
}

export interface SearchHit extends CatalogEntry {
  rank: number;
}

// Schema includes the prefix='2 3' option so 2- and 3-character queries
// (e.g. "zo", "gm") lookup directly instead of scanning the whole index.
// trigram tokenizer already handles 3+ char substrings, but its smallest
// indexable unit is one trigram (3 chars), so a 2-char query alone has no
// trigram to match against — the prefix index covers that gap.
const SCHEMA_SQL = `
  CREATE VIRTUAL TABLE catalog_fts USING fts5(
    kind UNINDEXED,
    id UNINDEXED,
    dbroot,
    label,
    snippet,
    body,
    tokenize='trigram',
    prefix='2 3'
  )
`;

let prepared = false;

function prepare(db: Database) {
  if (prepared) return;
  // Migrate older schemas (no prefix index) by detecting their CREATE SQL in
  // sqlite_master and dropping. Index is rebuilt by the next backfill /
  // ingest call. Idempotent: a fresh install just creates and skips the drop.
  const existing = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='catalog_fts'",
    )
    .get();
  if (existing && !existing.sql.includes("prefix='2 3'")) {
    console.log("[catalog] migrating catalog_fts: adding prefix='2 3'");
    db.run("DROP TABLE catalog_fts");
  }
  if (!existing || !existing.sql.includes("prefix='2 3'")) {
    db.run(SCHEMA_SQL);
  }
  prepared = true;
}

/** Insert or replace a single catalog entry. Idempotent: deletes any prior
 *  row for the same (kind,id) before inserting. */
export async function upsertCatalogEntry(entry: CatalogEntry): Promise<void> {
  const db = await getDb();
  prepare(db);
  db.run("DELETE FROM catalog_fts WHERE kind = ? AND id = ?", [entry.kind, entry.id]);
  db.run(
    "INSERT INTO catalog_fts(kind, id, dbroot, label, snippet, body) VALUES (?, ?, ?, ?, ?, ?)",
    [entry.kind, entry.id, entry.dbroot, entry.label, entry.snippet, entry.body],
  );
}

/** Batch upsert. Wraps in a single transaction so a 10k-row backfill takes
 *  seconds instead of minutes. */
export async function upsertCatalogEntries(entries: CatalogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  prepare(db);
  const del = db.prepare("DELETE FROM catalog_fts WHERE kind = ? AND id = ?");
  const ins = db.prepare(
    "INSERT INTO catalog_fts(kind, id, dbroot, label, snippet, body) VALUES (?, ?, ?, ?, ?, ?)",
  );
  db.transaction((rows: CatalogEntry[]) => {
    for (const r of rows) {
      del.run(r.kind, r.id);
      ins.run(r.kind, r.id, r.dbroot, r.label, r.snippet, r.body);
    }
  })(entries);
}

export async function removeCatalogEntry(kind: CatalogEntry["kind"], id: string): Promise<void> {
  const db = await getDb();
  prepare(db);
  db.run("DELETE FROM catalog_fts WHERE kind = ? AND id = ?", [kind, id]);
}

/** Full-text search. Empty/whitespace query returns []. FTS5 syntax is
 *  passed through (so callers can use phrase / prefix / boolean ops). */
export async function searchCatalog(
  q: string,
  opts: { kind?: CatalogEntry["kind"]; limit?: number } = {},
): Promise<SearchHit[]> {
  const term = q.trim();
  if (!term) return [];
  const db = await getDb();
  prepare(db);

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  // FTS5 throws on malformed match strings (e.g. unbalanced quotes). Wrap
  // each token in quotes + add a prefix wildcard so callers can type free
  // text like "iq gameboy" and get prefix-matched hits.
  const safe = term
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");

  const sql = opts.kind
    ? `SELECT kind, id, dbroot, label, snippet, body, rank
         FROM catalog_fts WHERE catalog_fts MATCH ? AND kind = ?
         ORDER BY rank LIMIT ?`
    : `SELECT kind, id, dbroot, label, snippet, body, rank
         FROM catalog_fts WHERE catalog_fts MATCH ?
         ORDER BY rank LIMIT ?`;

  try {
    const stmt = db.prepare(sql);
    const rows = opts.kind
      ? (stmt.all(safe, opts.kind, limit) as SearchHit[])
      : (stmt.all(safe, limit) as SearchHit[]);
    return rows;
  } catch (e) {
    console.warn("[catalog] search error:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function catalogStats(): Promise<{ total: number; byKind: Record<string, number> }> {
  const db = await getDb();
  prepare(db);
  const total = (db.query<{ n: number }, []>("SELECT count(*) AS n FROM catalog_fts").get())?.n ?? 0;
  const rows = db.query<{ kind: string; n: number }, []>(
    "SELECT kind, count(*) AS n FROM catalog_fts GROUP BY kind",
  ).all();
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.kind] = r.n;
  return { total, byKind };
}
