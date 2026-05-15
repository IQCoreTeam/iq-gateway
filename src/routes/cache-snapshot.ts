// /cache/* — public read-only cache APIs.
//
// The gateway is read-only by design. This module preserves that:
// peers can DOWNLOAD a snapshot of the cache to bootstrap a cold gateway,
// and explorer clients can browse cached entries, but no one writes to the
// cache over HTTP. Bootstrap is a filesystem operation on the operator's own
// machine before/while the gateway runs.
//
// Snapshot format: tar.gz of CACHE_DIR with a VACUUM-INTO consistent
// cache.db plus all blob subdirectories. Recipient untars into their
// CACHE_DIR and starts/restarts their gateway.

import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { metaCache, imageCache, userStateCache } from "../cache/memory";
import { snsCache, snsInflight } from "../chain/sns";
import { rowsCache, indexCache, sliceCache, inflight as tableInflight } from "./table";

const CACHE_DIR = process.env.CACHE_DIR || "./cache";
const CACHE_ROOT = resolve(CACHE_DIR);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PREVIEW_BYTES = 64 * 1024;
const CACHE_TYPES = [
  "meta",
  "img",
  "rows",
  "user",
  "render",
  "view",
  "site",
  "site-file",
  "signer-index",
  "sns",
] as const;

export const cacheRouter = new Hono();

type CacheType = typeof CACHE_TYPES[number];

interface CacheRow {
  key: string;
  type: CacheType;
  path: string;
  size: number;
  created_at: number;
  last_accessed: number;
}

interface Cursor {
  lastAccessed: number;
  key: string;
}

function dbPath(): string {
  return join(CACHE_DIR, "cache.db");
}

function openReadonlyDb(): Database | null {
  const p = dbPath();
  if (!existsSync(p)) return null;
  return new Database(p, { readonly: true });
}

function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function isCacheType(raw: string | undefined): raw is CacheType {
  return !!raw && (CACHE_TYPES as readonly string[]).includes(raw);
}

function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function encodeCursor(row: CacheRow): string {
  return toBase64Url(JSON.stringify({ lastAccessed: row.last_accessed, key: row.key }));
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const decoded = fromBase64Url(raw);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as Partial<Cursor>;
    if (typeof parsed.lastAccessed !== "number" || typeof parsed.key !== "string") return null;
    return { lastAccessed: parsed.lastAccessed, key: parsed.key };
  } catch {
    return null;
  }
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function cacheKeyWithoutType(row: CacheRow): string {
  const prefix = `${row.type}:`;
  return row.key.startsWith(prefix) ? row.key.slice(prefix.length) : row.key;
}

function canonicalPath(row: CacheRow): string {
  const ext = row.type === "img" ? ".bin" : ".json";
  return join(CACHE_DIR, row.type, hashKey(cacheKeyWithoutType(row)) + ext);
}

function isInsideCacheDir(path: string): boolean {
  const rel = relative(CACHE_ROOT, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.includes("\0"));
}

function candidatePaths(row: CacheRow): string[] {
  return Array.from(new Set([row.path, canonicalPath(row)]))
    .filter((p) => isInsideCacheDir(p) && existsSync(p));
}

function publicEntry(row: CacheRow) {
  return {
    id: toBase64Url(row.key),
    key: row.key,
    cacheKey: cacheKeyWithoutType(row),
    type: row.type,
    size: row.size,
    createdAt: row.created_at,
    lastAccessed: row.last_accessed,
  };
}

function contentTypeFor(row: CacheRow): string {
  if (row.type === "img") return "application/octet-stream";
  if (["meta", "rows", "user", "site", "signer-index", "sns"].includes(row.type)) return "application/json";
  if (["render", "view", "site-file"].includes(row.type)) return "application/octet-stream";
  return "application/octet-stream";
}

function summarizeText(text: string, truncated: boolean) {
  try {
    return { kind: "json", value: JSON.parse(text), truncated };
  } catch {
    return { kind: "text", text, truncated };
  }
}

function summarizeValue(value: unknown) {
  if (Buffer.isBuffer(value)) {
    return { kind: "binary", bytes: value.length };
  }
  if (typeof value === "string") {
    const truncated = Buffer.byteLength(value) > PREVIEW_BYTES;
    return summarizeText(truncated ? value.slice(0, PREVIEW_BYTES) : value, truncated);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= PREVIEW_BYTES) {
    return { kind: "json", value, truncated: false };
  }
  return { kind: "json", text: json.slice(0, PREVIEW_BYTES), truncated: true };
}

async function previewForPath(path: string) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, 0);
    const truncated = stat.size > length;
    if (buffer.includes(0)) {
      return { kind: "binary", bytes: stat.size, truncated };
    }
    return { ...summarizeText(buffer.toString("utf8"), truncated), bytes: stat.size };
  } finally {
    await file.close();
  }
}

function rowByEncodedId(encodedId: string): CacheRow | null {
  const key = fromBase64Url(encodedId);
  if (!key) return null;
  const db = openReadonlyDb();
  if (!db) return null;
  try {
    return db.query<CacheRow, [string]>(
      "SELECT key, type, path, size, created_at, last_accessed FROM cache_entries WHERE key = ?",
    ).get(key) ?? null;
  } finally {
    db.close();
  }
}

async function runShell(script: string): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stderr = exitCode === 0 ? "" : await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

cacheRouter.get("/info", (c) => {
  const db = openReadonlyDb();
  if (!db) return c.json({ entries: 0, totalSize: 0, byType: {}, cacheDir: CACHE_DIR });
  const total = db.query<{ n: number; bytes: number }, []>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM cache_entries",
  ).get();
  const byType: Record<string, { entries: number; bytes: number }> = {};
  for (const row of db.query<{ type: string; n: number; bytes: number }, []>(
    "SELECT type, COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM cache_entries GROUP BY type ORDER BY n DESC",
  ).all()) {
    byType[row.type] = { entries: row.n, bytes: row.bytes };
  }
  db.close();
  return c.json({
    entries: total?.n ?? 0,
    totalSize: total?.bytes ?? 0,
    byType,
    cacheDir: CACHE_DIR,
  });
});

cacheRouter.get("/entries", (c) => {
  const db = openReadonlyDb();
  const limit = parseLimit(c.req.query("limit"));
  const type = c.req.query("type");
  const q = c.req.query("q");
  const cursor = decodeCursor(c.req.query("cursor"));

  if (type && !isCacheType(type)) {
    return c.json({ error: "invalid cache type", types: CACHE_TYPES }, 400);
  }
  if (c.req.query("cursor") && !cursor) {
    return c.json({ error: "invalid cursor" }, 400);
  }
  if (!db) {
    return c.json({ entries: [], count: 0, limit, nextCursor: null, cacheDir: CACHE_DIR });
  }

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  if (q) {
    where.push("key LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(q)}%`);
  }
  if (cursor) {
    where.push("(last_accessed < ? OR (last_accessed = ? AND key > ?))");
    params.push(cursor.lastAccessed, cursor.lastAccessed, cursor.key);
  }

  const sql = [
    "SELECT key, type, path, size, created_at, last_accessed FROM cache_entries",
    where.length ? `WHERE ${where.join(" AND ")}` : "",
    "ORDER BY last_accessed DESC, key ASC",
    "LIMIT ?",
  ].filter(Boolean).join(" ");
  params.push(limit);

  try {
    const rows = db.query<CacheRow, Array<string | number>>(sql).all(...params);
    return c.json({
      entries: rows.map(publicEntry),
      count: rows.length,
      limit,
      nextCursor: rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null,
      cacheDir: CACHE_DIR,
    });
  } finally {
    db.close();
  }
});

cacheRouter.get("/entries/:id", async (c) => {
  const row = rowByEncodedId(c.req.param("id"));
  if (!row) return c.json({ error: "cache entry not found" }, 404);

  const paths = candidatePaths(row);
  const path = paths[0];
  const preview = path ? await previewForPath(path).catch(() => null) : null;

  return c.json({
    entry: publicEntry(row),
    hasBlob: !!path,
    contentType: contentTypeFor(row),
    preview,
  });
});

cacheRouter.get("/blob/:id", (c) => {
  const row = rowByEncodedId(c.req.param("id"));
  if (!row) return c.json({ error: "cache entry not found" }, 404);

  const path = candidatePaths(row)[0];
  if (!path) return c.json({ error: "cache blob missing" }, 404);

  const file = Bun.file(path);
  return new Response(file.stream(), {
    headers: {
      "content-type": contentTypeFor(row),
      "content-disposition": `inline; filename="${row.type}-${toBase64Url(cacheKeyWithoutType(row)).slice(0, 24)}"`,
      "x-cache-entry-id": toBase64Url(row.key),
      "x-cache-entry-type": row.type,
    },
  });
});

const memoryCaches = {
  meta: metaCache,
  images: imageCache,
  userState: userStateCache,
  sns: snsCache,
  tableRows: rowsCache,
  tableIndex: indexCache,
  tableSlice: sliceCache,
};

type MemoryCacheName = keyof typeof memoryCaches;

function isMemoryCacheName(raw: string | undefined): raw is MemoryCacheName {
  return !!raw && raw in memoryCaches;
}

cacheRouter.get("/memory", (c) => {
  const cache = c.req.query("cache");
  const includeValues = c.req.query("includeValues") === "true";
  const limit = parseLimit(c.req.query("limit"));
  const offset = Math.max(0, Number(c.req.query("cursor")) || 0);

  if (!cache || cache === "all") {
    return c.json({
      caches: Object.fromEntries(
        Object.entries(memoryCaches).map(([name, mem]) => [name, { entries: mem.snapshot(false).length }]),
      ),
      inflight: {
        table: tableInflight.size,
        sns: snsInflight.size,
      },
    });
  }

  if (!isMemoryCacheName(cache)) {
    return c.json({ error: "invalid memory cache", caches: Object.keys(memoryCaches) }, 400);
  }

  const all = memoryCaches[cache].snapshot(includeValues);
  const page = all.slice(offset, offset + limit);

  return c.json({
    cache,
    entries: page.map((entry) => ({
      key: entry.key,
      expiresAt: entry.expiresAt,
      ttlMs: entry.ttlMs,
      ...(includeValues && "value" in entry ? { preview: summarizeValue(entry.value) } : {}),
    })),
    count: page.length,
    total: all.length,
    limit,
    nextCursor: offset + limit < all.length ? String(offset + limit) : null,
  });
});

cacheRouter.get("/snapshot", async (c) => {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stage = `/tmp/cache-snapshot-${tag}`;

  // Stage every cache subdir / blob file. Skip the live cache.db and
  // its WAL/SHM journals — we'll write a fresh consistent cache.db via
  // VACUUM INTO so the recipient sqlite opens cleanly.
  const setup = await runShell([
    "set -e",
    `mkdir -p ${stage}`,
    `cd ${CACHE_DIR}`,
    `find . -mindepth 1 -maxdepth 1 -not -name 'cache.db' -not -name 'cache.db-shm' -not -name 'cache.db-wal' -exec cp -r {} ${stage}/ \\;`,
  ].join(" && "));
  if (setup.exitCode !== 0) {
    await runShell(`rm -rf ${stage}`);
    return c.json({ error: "snapshot setup failed", stderr: setup.stderr }, 500);
  }

  const liveDb = dbPath();
  if (existsSync(liveDb)) {
    try {
      const db = new Database(liveDb, { readonly: true });
      const stageDb = join(stage, "cache.db").replace(/'/g, "''");
      db.run(`VACUUM INTO '${stageDb}'`);
      db.close();
    } catch (e) {
      console.error("[cache] VACUUM INTO failed, copying live db as-is:", e);
      await runShell(`cp ${liveDb} ${join(stage, "cache.db")}`);
    }
  }

  // Stream tar's stdout directly to the client. Bytes start flowing
  // immediately — no buffer-to-file step. Avoids Cloudflare 100s
  // timeouts on large caches and keeps memory low.
  const tar = Bun.spawn(
    ["sh", "-c", `cd ${stage} && tar -czf - . ; status=$? ; rm -rf ${stage} ; exit $status`],
    { stdout: "pipe", stderr: "pipe" },
  );

  return new Response(tar.stdout, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": 'attachment; filename="cache-snapshot.tar.gz"',
      "x-cache-snapshot-version": "2",
    },
  });
});
