// Disk cache for persistence across restarts

import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CACHE_DIR = process.env.CACHE_DIR || "./cache";

async function ensureCacheDir(subdir: string): Promise<string> {
  const dir = join(CACHE_DIR, subdir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export async function getDiskCache(
  type: "meta" | "img",
  key: string
): Promise<Buffer | null> {
  try {
    const dir = await ensureCacheDir(type);
    const ext = type === "meta" ? ".json" : ".bin";
    const filePath = join(dir, hashKey(key) + ext);

    const stats = await stat(filePath);
    const maxAge = type === "meta" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

    if (Date.now() - stats.mtimeMs > maxAge) {
      await unlink(filePath).catch(() => {});
      return null;
    }

    return await readFile(filePath);
  } catch {
    return null;
  }
}

export async function setDiskCache(
  type: "meta" | "img",
  key: string,
  data: Buffer | string
): Promise<void> {
  try {
    const dir = await ensureCacheDir(type);
    const ext = type === "meta" ? ".json" : ".bin";
    const filePath = join(dir, hashKey(key) + ext);
    await writeFile(filePath, data);
  } catch (err) {
    console.error("Disk cache write error:", err);
  }
}

export async function deleteDiskCache(
  type: "meta" | "img",
  key: string
): Promise<void> {
  try {
    const dir = await ensureCacheDir(type);
    const ext = type === "meta" ? ".json" : ".bin";
    const filePath = join(dir, hashKey(key) + ext);
    await unlink(filePath);
  } catch {
    // Ignore deletion errors
  }
}
