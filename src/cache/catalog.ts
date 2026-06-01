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
  network?: string;  // chain/network the entry came from; defaults to 'solana'
}

export interface SearchHit extends CatalogEntry {
  rank: number;
}

let prepared = false;

const DEFAULT_NETWORK = "solana";

function hasNetworkColumn(db: Database): boolean {
  try {
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(catalog_fts)").all();
    return cols.some((c) => c.name === "network");
  } catch {
    return false;
  }
}

function prepare(db: Database) {
  if (prepared) return;
  // FTS5 can't ALTER to add a column. catalog_fts is a DERIVED search index
  // (on-chain is the source of truth), so when an old single-chain index is
  // found without `network`, drop + recreate and let the backfill job repopulate.
  // Lossless: nothing here is canonical data.
  const exists = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name='catalog_fts'")
    .get();
  if (exists && exists.n > 0 && !hasNetworkColumn(db)) {
    db.run("DROP TABLE catalog_fts");
  }
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(
      kind UNINDEXED,
      id UNINDEXED,
      network UNINDEXED,
      dbroot,
      label,
      snippet,
      body,
      tokenize='trigram'
    )
  `);
  prepared = true;
}

/** Insert or replace a single catalog entry. Idempotent: deletes any prior
 *  row for the same (kind,id) before inserting. */
export async function upsertCatalogEntry(entry: CatalogEntry): Promise<void> {
  const db = await getDb();
  prepare(db);
  db.run("DELETE FROM catalog_fts WHERE kind = ? AND id = ?", [entry.kind, entry.id]);
  db.run(
    "INSERT INTO catalog_fts(kind, id, network, dbroot, label, snippet, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [entry.kind, entry.id, entry.network ?? DEFAULT_NETWORK, entry.dbroot, entry.label, entry.snippet, entry.body],
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
    "INSERT INTO catalog_fts(kind, id, network, dbroot, label, snippet, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction((rows: CatalogEntry[]) => {
    for (const r of rows) {
      del.run(r.kind, r.id);
      ins.run(r.kind, r.id, r.network ?? DEFAULT_NETWORK, r.dbroot, r.label, r.snippet, r.body);
    }
  })(entries);
}

export async function removeCatalogEntry(kind: CatalogEntry["kind"], id: string): Promise<void> {
  const db = await getDb();
  prepare(db);
  db.run("DELETE FROM catalog_fts WHERE kind = ? AND id = ?", [kind, id]);
}

/** Full-text search. Empty/whitespace query returns []. Long enough terms
 *  go through FTS5 (trigram tokenizer — substring match, BM25 ranking).
 *  Terms with any sub-3-char token fall back to LIKE since trigram has no
 *  token shorter than 3 chars to match against; the index size is small
 *  enough that a scan is cheap and the alternative is 0 hits. */
export async function searchCatalog(
  q: string,
  opts: { kind?: CatalogEntry["kind"]; limit?: number; network?: string } = {},
): Promise<SearchHit[]> {
  const term = q.trim();
  if (!term) return [];
  const db = await getDb();
  prepare(db);

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const tokens = term.split(/\s+/).filter(Boolean);
  const tooShort = tokens.some((t) => t.length < 3);

  if (tooShort) {
    // Escape LIKE wildcards in user input. Match against label/snippet/body
    // — the same columns FTS5 would index. Order by label ASC for stable
    // pagination; BM25 isn't available off-FTS so we don't fake a rank.
    const escape = (s: string) => s.replace(/[\\%_]/g, "\\$&");
    const patterns = tokens.map((t) => `%${escape(t)}%`);
    const where = patterns
      .map(() => `(label LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`)
      .join(" AND ");
    const args: (string | number)[] = [];
    for (const p of patterns) args.push(p, p, p);
    const kindClause = opts.kind ? " AND kind = ?" : "";
    if (opts.kind) args.push(opts.kind);
    const netClause = opts.network ? " AND network = ?" : "";
    if (opts.network) args.push(opts.network);
    args.push(limit);

    try {
      const stmt = db.prepare(
        `SELECT kind, id, network, dbroot, label, snippet, body, 0 AS rank
           FROM catalog_fts WHERE ${where}${kindClause}${netClause}
           ORDER BY label LIMIT ?`,
      );
      return stmt.all(...args) as SearchHit[];
    } catch (e) {
      console.warn("[catalog] LIKE search error:", e instanceof Error ? e.message : e);
      return [];
    }
  }

  // FTS5 throws on malformed match strings (e.g. unbalanced quotes). Wrap
  // each token in quotes + add a prefix wildcard so callers can type free
  // text like "iq gameboy" and get prefix-matched hits.
  const safe = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");

  const kindClause = opts.kind ? " AND kind = ?" : "";
  const netClause = opts.network ? " AND network = ?" : "";
  const sql = `SELECT kind, id, network, dbroot, label, snippet, body, rank
         FROM catalog_fts WHERE catalog_fts MATCH ?${kindClause}${netClause}
         ORDER BY rank LIMIT ?`;
  const args: (string | number)[] = [safe];
  if (opts.kind) args.push(opts.kind);
  if (opts.network) args.push(opts.network);
  args.push(limit);

  try {
    const stmt = db.prepare(sql);
    return stmt.all(...args) as SearchHit[];
  } catch (e) {
    console.warn("[catalog] FTS search error:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function catalogStats(): Promise<{
  total: number;
  byKind: Record<string, number>;
  byNetwork: Record<string, number>;
}> {
  const db = await getDb();
  prepare(db);
  const total = (db.query<{ n: number }, []>("SELECT count(*) AS n FROM catalog_fts").get())?.n ?? 0;
  const rows = db.query<{ kind: string; n: number }, []>(
    "SELECT kind, count(*) AS n FROM catalog_fts GROUP BY kind",
  ).all();
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.kind] = r.n;
  const netRows = db.query<{ network: string; n: number }, []>(
    "SELECT network, count(*) AS n FROM catalog_fts GROUP BY network",
  ).all();
  const byNetwork: Record<string, number> = {};
  for (const r of netRows) byNetwork[r.network] = r.n;
  return { total, byKind, byNetwork };
}
