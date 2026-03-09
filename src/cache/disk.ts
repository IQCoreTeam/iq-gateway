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

export async function getDiskCache(
  type: "meta" | "img" | "rows" | "user" | "render" | "view",
  key: string
): Promise<Buffer | null> {
  try {
    const entry = await getEntry(`${type}:${key}`);
    if (!entry) return null;

    const data = await readFile(entry.path);
    return data;
  } catch {
    // File missing but entry exists - clean up
    await removeEntry(`${type}:${key}`);
    return null;
  }
}

export async function setDiskCache(
  type: "meta" | "img" | "rows" | "user" | "render" | "view",
  key: string,
  data: Buffer | string
): Promise<void> {
  try {
    const dir = await ensureCacheDir(type);
    const ext = type === "img" ? ".bin" : ".json";
    const filePath = join(dir, hashKey(key) + ext);
    const buf = typeof data === "string" ? Buffer.from(data) : data;

    await writeFile(filePath, buf);
    await recordEntry(`${type}:${key}`, type, filePath, buf.length);
  } catch (err) {
    console.error("Disk cache write error:", err);
  }
}

