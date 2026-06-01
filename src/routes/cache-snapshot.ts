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
import { existsSync, mkdirSync } from "node:fs";
import { lstat, open, realpath, rename, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { metaCache, imageCache, userStateCache } from "../cache/memory";
import { snsCache, snsInflight } from "../chain/solana/sns";
import { rowsCache, indexCache, sliceCache, inflight as tableInflight } from "./table";
import { checkAdminAuth } from "./admin";

const CACHE_DIR = process.env.CACHE_DIR || "./cache";
const CACHE_ROOT = resolve(CACHE_DIR);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MIN_QUERY_CHARS = 3;
const MAX_QUERY_CHARS = 256;
const PREVIEW_BYTES = 64 * 1024;
const MEMORY_PREVIEW_BYTES = 8 * 1024;
const MAX_MEMORY_VALUE_LIMIT = 50;
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

function parseOffsetCursor(raw: string | undefined): number | null {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function parseSearchQuery(raw: string | undefined): string | null {
  const q = raw?.trim();
  return q ? q : null;
}

function isSearchQueryTooShort(q: string | null): boolean {
  return !!q && q.length < MIN_QUERY_CHARS;
}

function isSearchQueryTooLong(raw: string | undefined): boolean {
  return !!raw && raw.length > MAX_QUERY_CHARS;
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

function ftsPhrase(raw: string): string {
  return `"${raw.replaceAll('"', '""')}"`;
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

function isInsideRoot(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.includes("\0"));
}

function isInsideCacheDir(path: string): boolean {
  return isInsideRoot(CACHE_ROOT, path);
}

async function realCacheRoot(): Promise<string | null> {
  try {
    return await realpath(CACHE_ROOT);
  } catch {
    return null;
  }
}

async function resolveCandidatePath(path: string): Promise<string | null> {
  if (!isInsideCacheDir(path)) return null;

  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return null;

    const [root, real] = await Promise.all([realCacheRoot(), realpath(path)]);
    if (!root || !isInsideRoot(root, real)) return null;
    return real;
  } catch {
    return null;
  }
}

async function candidatePaths(row: CacheRow): Promise<string[]> {
  const out: string[] = [];
  for (const p of Array.from(new Set([row.path, canonicalPath(row)]))) {
    const resolved = await resolveCandidatePath(p);
    if (resolved) out.push(resolved);
  }
  return out;
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

function summarizeValue(value: unknown, previewBytes = PREVIEW_BYTES) {
  if (Buffer.isBuffer(value)) {
    return { kind: "binary", bytes: value.length };
  }
  if (typeof value === "string") {
    const truncated = Buffer.byteLength(value) > previewBytes;
    const text = truncated ? Buffer.from(value).subarray(0, previewBytes).toString("utf8") : value;
    return summarizeText(text, truncated);
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    json = String(value);
  }
  if (Buffer.byteLength(json) <= previewBytes) {
    return { kind: "json", value, truncated: false };
  }
  return { kind: "json", text: Buffer.from(json).subarray(0, previewBytes).toString("utf8"), truncated: true };
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

function hasExplorerSearchIndex(): boolean {
  const db = openReadonlyDb();
  if (!db) return false;
  try {
    return !!db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cache_entries_fts'",
    ).get();
  } finally {
    db.close();
  }
}

cacheRouter.get("/info", (c) => {
  const db = openReadonlyDb();
  if (!db) return c.json({ entries: 0, totalSize: 0, byType: {} });
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
  });
});

cacheRouter.get("/entries", (c) => {
  const limit = parseLimit(c.req.query("limit"));
  const type = c.req.query("type");
  const q = parseSearchQuery(c.req.query("q"));
  const cursor = decodeCursor(c.req.query("cursor"));

  if (isSearchQueryTooLong(c.req.query("q"))) {
    return c.json({ error: "q is too long", maxChars: MAX_QUERY_CHARS }, 400);
  }
  if (isSearchQueryTooShort(q)) {
    return c.json({ error: "q is too short", minChars: MIN_QUERY_CHARS }, 400);
  }
  if (type && !isCacheType(type)) {
    return c.json({ error: "invalid cache type", types: CACHE_TYPES }, 400);
  }
  if (c.req.query("cursor") && !cursor) {
    return c.json({ error: "invalid cursor" }, 400);
  }
  if (q && !hasExplorerSearchIndex()) {
    return c.json({ error: "cache search index unavailable" }, 503);
  }

  const db = openReadonlyDb();
  if (!db) {
    return c.json({ entries: [], count: 0, limit, nextCursor: null });
  }

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (type) {
    where.push("ce.type = ?");
    params.push(type);
  }
  if (q) {
    where.push("fts.key MATCH ?");
    params.push(ftsPhrase(q));
  }
  if (cursor) {
    where.push("(ce.last_accessed < ? OR (ce.last_accessed = ? AND ce.key > ?))");
    params.push(cursor.lastAccessed, cursor.lastAccessed, cursor.key);
  }

  const sql = [
    "SELECT ce.key, ce.type, ce.path, ce.size, ce.created_at, ce.last_accessed FROM cache_entries ce",
    q ? "JOIN cache_entries_fts fts ON fts.rowid = ce.rowid" : "",
    where.length ? `WHERE ${where.join(" AND ")}` : "",
    "ORDER BY ce.last_accessed DESC, ce.key ASC",
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
    });
  } finally {
    db.close();
  }
});

cacheRouter.get("/entries/:id", async (c) => {
  const row = rowByEncodedId(c.req.param("id"));
  if (!row) return c.json({ error: "cache entry not found" }, 404);

  const paths = await candidatePaths(row);
  const path = paths[0];
  const preview = path ? await previewForPath(path).catch(() => null) : null;

  return c.json({
    entry: publicEntry(row),
    hasBlob: !!path,
    contentType: contentTypeFor(row),
    preview,
  });
});

cacheRouter.get("/blob/:id", async (c) => {
  const row = rowByEncodedId(c.req.param("id"));
  if (!row) return c.json({ error: "cache entry not found" }, 404);

  const path = (await candidatePaths(row))[0];
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
  const requestedLimit = parseLimit(c.req.query("limit"));
  const limit = includeValues ? Math.min(requestedLimit, MAX_MEMORY_VALUE_LIMIT) : requestedLimit;
  const offset = parseOffsetCursor(c.req.query("cursor"));
  const q = parseSearchQuery(c.req.query("q"));

  if (isSearchQueryTooLong(c.req.query("q"))) {
    return c.json({ error: "q is too long", maxChars: MAX_QUERY_CHARS }, 400);
  }
  if (isSearchQueryTooShort(q)) {
    return c.json({ error: "q is too short", minChars: MIN_QUERY_CHARS }, 400);
  }
  if (offset === null) {
    return c.json({ error: "invalid cursor" }, 400);
  }
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

  const needle = q?.toLowerCase();
  const all = memoryCaches[cache]
    .snapshot(includeValues)
    .filter((entry) => !needle || entry.key.toLowerCase().includes(needle));
  const page = all.slice(offset, offset + limit);

  return c.json({
    cache,
    entries: page.map((entry) => ({
      key: entry.key,
      expiresAt: entry.expiresAt,
      ttlMs: entry.ttlMs,
      ...(includeValues && "value" in entry ? { preview: summarizeValue(entry.value, MEMORY_PREVIEW_BYTES) } : {}),
    })),
    count: page.length,
    total: all.length,
    limit,
    nextCursor: offset + limit < all.length ? String(offset + limit) : null,
  });
});

// Stage CACHE_DIR's blobs + a fresh VACUUM-INTO cache.db into a tmp dir.
// Caller is responsible for `rm -rf` of the returned path. Returns null
// on setup failure (with stderr already logged).
async function buildSnapshotStage(): Promise<{ stage: string } | { error: string }> {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stage = `/tmp/cache-snapshot-${tag}`;

  // Excludes the live DB (we VACUUM INTO a fresh one below) and the
  // backups/ subdirectory (otherwise each backup would nest the previous
  // one — quadratic growth across redeploys).
  const setup = await runShell([
    "set -e",
    `mkdir -p ${stage}`,
    `cd ${CACHE_DIR}`,
    `find . -mindepth 1 -maxdepth 1 -not -name 'cache.db' -not -name 'cache.db-shm' -not -name 'cache.db-wal' -not -name 'backups' -exec cp -r {} ${stage}/ \\;`,
  ].join(" && "));
  if (setup.exitCode !== 0) {
    await runShell(`rm -rf ${stage}`);
    return { error: setup.stderr };
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
  return { stage };
}

cacheRouter.get("/snapshot", async (c) => {
  const built = await buildSnapshotStage();
  if ("error" in built) return c.json({ error: "snapshot setup failed", stderr: built.error }, 500);

  // Stream tar's stdout directly to the client. Bytes start flowing
  // immediately — no buffer-to-file step. Avoids Cloudflare 100s
  // timeouts on large caches and keeps memory low.
  const tar = Bun.spawn(
    ["sh", "-c", `cd ${built.stage} && tar -czf - . ; status=$? ; rm -rf ${built.stage} ; exit $status`],
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

// POST /cache/backup — write a tar.gz to BACKUP_DIR/latest.tar.gz. Operators
// curl this before `docker compose up -d --build` so the snapshot lives in
// the PV (which is retained across redeploys). Atomic rename so a crashed
// backup never leaves a half-written file behind.
//
// Default BACKUP_DIR is inside CACHE_DIR so it inherits the PV mount with
// zero extra config — the snapshot routine knows to skip the `backups/`
// subdir so backups don't recursively pack previous backups.
//
// Auth: admin-only. Same Bearer token as /admin/*. If ADMIN_TOKEN is unset,
// the endpoint returns 401 (writing to the PV is not a public action).
const BACKUP_DIR = process.env.BACKUP_DIR || join(CACHE_DIR, "backups");
const BACKUP_FILE = join(BACKUP_DIR, "latest.tar.gz");

// Single in-flight backup at a time. Two concurrent backups would race on
// the same .tmp path and produce a truncated latest.tar.gz.
let backupRunning = false;

cacheRouter.post("/backup", async (c) => {
  if (!checkAdminAuth(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (backupRunning) {
    return c.json({ error: "backup already in progress" }, 409);
  }
  backupRunning = true;
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const built = await buildSnapshotStage();
    if ("error" in built) return c.json({ error: "snapshot setup failed", stderr: built.error }, 500);

    const tmp = `${BACKUP_FILE}.tmp`;
    const tar = Bun.spawn(
      ["sh", "-c", `cd ${built.stage} && tar -czf ${tmp} . ; status=$? ; rm -rf ${built.stage} ; exit $status`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exit = await tar.exited;
    if (exit !== 0) {
      const stderr = await new Response(tar.stderr).text();
      await runShell(`rm -f ${tmp}`);
      return c.json({ error: "tar failed", stderr }, 500);
    }

    await rename(tmp, BACKUP_FILE);
    const info = await stat(BACKUP_FILE);
    return c.json({
      path: BACKUP_FILE,
      sizeBytes: info.size,
      writtenAt: Date.now(),
    });
  } finally {
    backupRunning = false;
  }
});

cacheRouter.get("/backup", async (c) => {
  // Operators inspect what's currently sitting in BACKUP_DIR before
  // redeploying. No auth — read-only metadata, no contents.
  try {
    const info = await stat(BACKUP_FILE);
    return c.json({
      exists: true,
      path: BACKUP_FILE,
      sizeBytes: info.size,
      modifiedAt: info.mtimeMs,
    });
  } catch {
    return c.json({ exists: false, path: BACKUP_FILE });
  }
});
