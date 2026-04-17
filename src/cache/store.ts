import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir, unlink } from "node:fs/promises";

const CACHE_DIR = process.env.CACHE_DIR || "./cache";
const DB_PATH = join(CACHE_DIR, "cache.db");

// Parse size string like "10GB", "500MB" to bytes
function parseSize(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.floor(num * multipliers[unit]);
}

const MAX_CACHE_SIZE = parseSize(process.env.MAX_CACHE_SIZE || "10GB");

let db: Database | null = null;

async function getDb(): Promise<Database> {
  if (db) return db;
  await mkdir(CACHE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_last_accessed ON cache_entries(last_accessed)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_type ON cache_entries(type)`);
  return db;
}

export async function getTotalSize(): Promise<number> {
  const db = await getDb();
  const result = db.query<{ total: number }, []>("SELECT COALESCE(SUM(size), 0) as total FROM cache_entries").get();
  return result?.total || 0;
}

export async function recordEntry(
  key: string,
  type: "meta" | "img" | "rows" | "user" | "render" | "view" | "site" | "site-file" | "signer-index",
  path: string,
  size: number
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  db.run(
    `INSERT OR REPLACE INTO cache_entries (key, type, path, size, created_at, last_accessed)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [key, type, path, size, now, now]
  );
  await pruneIfNeeded();
}

export async function touchEntry(key: string): Promise<void> {
  const db = await getDb();
  db.run("UPDATE cache_entries SET last_accessed = ? WHERE key = ?", [Date.now(), key]);
}

export async function removeEntry(key: string): Promise<void> {
  const db = await getDb();
  const entry = db.query<{ path: string }, [string]>("SELECT path FROM cache_entries WHERE key = ?").get(key);
  if (entry) {
    await unlink(entry.path).catch(() => {});
    db.run("DELETE FROM cache_entries WHERE key = ?", [key]);
  }
}

export async function getEntry(key: string, maxAgeMs?: number): Promise<{ path: string; size: number } | null> {
  const db = await getDb();
  const entry = db.query<{ path: string; size: number; created_at: number }, [string]>(
    "SELECT path, size, created_at FROM cache_entries WHERE key = ?"
  ).get(key);
  if (!entry) return null;
  if (maxAgeMs && Date.now() - entry.created_at > maxAgeMs) {
    await removeEntry(key);
    return null;
  }
  await touchEntry(key);
  return entry;
}

async function pruneIfNeeded(): Promise<void> {
  if (MAX_CACHE_SIZE === 0) return; // No limit

  let total = await getTotalSize();
  if (total <= MAX_CACHE_SIZE) return;

  const db = await getDb();
  const entries = db.query<{ key: string; path: string; size: number }, []>(
    "SELECT key, path, size FROM cache_entries ORDER BY last_accessed ASC"
  ).all();

  for (const entry of entries) {
    if (total <= MAX_CACHE_SIZE * 0.9) break; // Prune to 90% to avoid constant pruning
    await unlink(entry.path).catch(() => {});
    db.run("DELETE FROM cache_entries WHERE key = ?", [entry.key]);
    total -= entry.size;
  }
}

export async function getStats(): Promise<{
  totalSize: number;
  maxSize: number;
  entryCount: number;
  usagePercent: number;
}> {
  const db = await getDb();
  const totalSize = await getTotalSize();
  const countResult = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM cache_entries").get();
  const entryCount = countResult?.count || 0;
  return {
    totalSize,
    maxSize: MAX_CACHE_SIZE,
    entryCount,
    usagePercent: MAX_CACHE_SIZE > 0 ? (totalSize / MAX_CACHE_SIZE) * 100 : 0,
  };
}

