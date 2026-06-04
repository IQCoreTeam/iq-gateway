import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { recordEntry, getEntry, removeEntry } from "./store";

const CACHE_DIR = process.env.CACHE_DIR || "./cache";

async function ensureCacheDir(subdir: string): Promise<string> {
  const dir = join(CACHE_DIR, subdir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Single source of truth for cache file paths. Used by both writes
// (set) and the read-fallback (get) so we can never disagree on
// "where is type=X key=Y stored on disk".
function pathFor(type: string, key: string): string {
  const ext = type === "img" ? ".bin" : ".json";
  return join(CACHE_DIR, type, hashKey(key) + ext);
}

// Disk cache is permanent for immutable on-chain data (rows, meta, img).
// User data is mutable (profile updates, connections) so it still expires.
const DISK_TTL: Partial<Record<string, number>> = {
  user: 2 * 60 * 1000,    // 2 minutes — mutable profile/connection data
};

export async function getDiskCache(
  type: "meta" | "img" | "rows" | "user" | "render" | "view" | "site" | "site-file" | "signer-index" | "sns" | "ens",
  key: string
): Promise<Buffer | null> {
  const entry = await getEntry(`${type}:${key}`, DISK_TTL[type]);
  if (!entry) return null;
  // Try the stored path first (fast path for entries written this
  // process); fall back to the canonical pathFor() so caches imported
  // from a peer (where the stored path may be relative to a different
  // CACHE_DIR) still resolve.
  for (const path of [entry.path, pathFor(type, key)]) {
    try { return await readFile(path); } catch {}
  }
  await removeEntry(`${type}:${key}`);
  return null;
}

export async function setDiskCache(
  type: "meta" | "img" | "rows" | "user" | "render" | "view" | "site" | "site-file" | "signer-index" | "sns" | "ens",
  key: string,
  data: Buffer | string
): Promise<void> {
  try {
    await ensureCacheDir(type);
    const filePath = pathFor(type, key);
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    await writeFile(filePath, buf);
    await recordEntry(`${type}:${key}`, type, filePath, buf.length);
  } catch (err) {
    console.error("Disk cache write error:", err);
  }
}

