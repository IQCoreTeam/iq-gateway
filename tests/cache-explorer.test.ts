import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CACHE_DIR } from "./helpers/cache-fixture";

const { cacheRouter } = await import("../src/routes/cache-snapshot");
const { metaCache } = await import("../src/cache/memory");
const { ensureCacheSearchIndex } = await import("../src/cache/store");

async function writeEntry(type: string, cacheKey: string, data: string | Buffer): Promise<void> {
  const dir = join(CACHE_DIR, type);
  await mkdir(dir, { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  const path = join(dir, `${type}-${cacheKey}.json`);
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  await writeFile(path, buf);

  const db = new Database(join(CACHE_DIR, "cache.db"));
  try {
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
    const now = Date.now();
    db.run(
      `INSERT OR REPLACE INTO cache_entries (key, type, path, size, created_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`${type}:${cacheKey}`, type, path, buf.length, now, now],
    );
    ensureCacheSearchIndex(db);
  } finally {
    db.close();
  }
}

async function writeEntryPath(type: string, cacheKey: string, path: string, size: number): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });

  const db = new Database(join(CACHE_DIR, "cache.db"));
  try {
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
    const now = Date.now();
    db.run(
      `INSERT OR REPLACE INTO cache_entries (key, type, path, size, created_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`${type}:${cacheKey}`, type, path, size, now, now],
    );
    ensureCacheSearchIndex(db);
  } finally {
    db.close();
  }
}

describe("cache explorer API", () => {
  test("lists disk cache entries and returns JSON previews/blobs", async () => {
    await writeEntry("rows", "explorer-rows-a", JSON.stringify({ ok: true, n: 1 }));
    await writeEntry("meta", "explorer-meta-a", JSON.stringify({ name: "meta" }));

    const listRes = await cacheRouter.request("/entries?type=rows&q=explorer-rows-a&limit=10");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();

    expect(list.entries.length).toBe(1);
    expect(list.entries[0].type).toBe("rows");
    expect(list.entries[0].cacheKey).toBe("explorer-rows-a");
    expect(typeof list.entries[0].id).toBe("string");

    const detailRes = await cacheRouter.request(`/entries/${list.entries[0].id}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();

    expect(detail.entry.key).toBe("rows:explorer-rows-a");
    expect(detail.hasBlob).toBe(true);
    expect(detail.preview.kind).toBe("json");
    expect(detail.preview.value).toEqual({ ok: true, n: 1 });

    const blobRes = await cacheRouter.request(`/blob/${list.entries[0].id}`);
    expect(blobRes.status).toBe(200);
    expect(await blobRes.json()).toEqual({ ok: true, n: 1 });
  });

  test("does not follow cache blob symlinks outside CACHE_DIR", async () => {
    const outsidePath = join(CACHE_DIR, "..", `outside-${process.pid}.txt`);
    const linkPath = join(CACHE_DIR, "rows", "escape-link.json");
    await mkdir(join(CACHE_DIR, "rows"), { recursive: true });
    await writeFile(outsidePath, "outside secret");
    await symlink(outsidePath, linkPath);
    await writeEntryPath("rows", "explorer-symlink-a", linkPath, "outside secret".length);

    const listRes = await cacheRouter.request("/entries?type=rows&q=explorer-symlink-a&limit=10");
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.entries.length).toBe(1);

    const detailRes = await cacheRouter.request(`/entries/${list.entries[0].id}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.hasBlob).toBe(false);
    expect(detail.preview).toBeNull();

    const blobRes = await cacheRouter.request(`/blob/${list.entries[0].id}`);
    expect(blobRes.status).toBe(404);
  });

  test("paginates disk cache entries with opaque cursors", async () => {
    await writeEntry("rows", "explorer-page-a", JSON.stringify({ page: "a" }));
    await writeEntry("rows", "explorer-page-b", JSON.stringify({ page: "b" }));

    const firstRes = await cacheRouter.request("/entries?type=rows&q=explorer-page&limit=1");
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json();

    expect(first.entries.length).toBe(1);
    expect(typeof first.nextCursor).toBe("string");

    const secondRes = await cacheRouter.request(`/entries?type=rows&q=explorer-page&limit=1&cursor=${first.nextCursor}`);
    expect(secondRes.status).toBe(200);
    const second = await secondRes.json();

    expect(second.entries.length).toBe(1);
    expect(second.entries[0].key).not.toBe(first.entries[0].key);
  });

  test("lists memory cache summaries and optional value previews", async () => {
    metaCache.set("memory-explorer-a", JSON.stringify({ cached: true }), 60_000);
    metaCache.set("memory-other", JSON.stringify({ cached: false }), 60_000);

    const summaryRes = await cacheRouter.request("/memory");
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json();
    expect(summary.caches.meta.entries).toBeGreaterThan(0);

    const detailRes = await cacheRouter.request("/memory?cache=meta&includeValues=true&limit=50");
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    const entry = detail.entries.find((e: { key: string }) => e.key === "memory-explorer-a");

    expect(entry).toBeTruthy();
    expect(entry.preview.kind).toBe("json");
    expect(entry.preview.value).toEqual({ cached: true });

    const filteredRes = await cacheRouter.request("/memory?cache=meta&q=explorer-a&includeValues=true&limit=50");
    expect(filteredRes.status).toBe(200);
    const filtered = await filteredRes.json();

    expect(filtered.entries.some((e: { key: string }) => e.key === "memory-explorer-a")).toBe(true);
    expect(filtered.entries.some((e: { key: string }) => e.key === "memory-other")).toBe(false);
  });

  test("rejects invalid explorer filters", async () => {
    const badType = await cacheRouter.request("/entries?type=nope");
    expect(badType.status).toBe(400);

    const badCursor = await cacheRouter.request("/entries?cursor=not-base64!!!");
    expect(badCursor.status).toBe(400);

    const badMemory = await cacheRouter.request("/memory?cache=nope");
    expect(badMemory.status).toBe(400);

    const badMemoryCursor = await cacheRouter.request("/memory?cache=meta&cursor=nope");
    expect(badMemoryCursor.status).toBe(400);

    const shortQuery = await cacheRouter.request("/entries?q=ab");
    expect(shortQuery.status).toBe(400);

    const longQuery = "x".repeat(257);
    const badQuery = await cacheRouter.request(`/entries?q=${longQuery}`);
    expect(badQuery.status).toBe(400);
  });
});
