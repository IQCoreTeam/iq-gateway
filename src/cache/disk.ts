import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { recordEntry, getEntry, removeEntry } from "./store";

const CACHE_DIR = process.env.CACHE_DIR || "./cache";

// The historical single chain. Its keys + paths stay UNPREFIXED so a pre-
// multichain cache (all Solana) keeps resolving with zero re-fetch and no file
// moves. Every other network is namespaced, which is what stops 0xABC-on-sepolia
// from colliding with 0xABC-on-monad. See store.ts migration note.
const DEFAULT_NETWORK = "solana";

type Network = string;

async function ensureCacheDir(network: Network, subdir: string): Promise<string> {
  const base = network === DEFAULT_NETWORK ? CACHE_DIR : join(CACHE_DIR, network);
  const dir = join(base, subdir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// The SQLite key. Default network is unprefixed (back-compat); others carry the
// network so the same (type,key) on two chains are distinct rows.
function storeKey(network: Network, type: string, key: string): string {
  return network === DEFAULT_NETWORK ? `${type}:${key}` : `${network}:${type}:${key}`;
}

// Single source of truth for cache file paths. Used by both writes
// (set) and the read-fallback (get) so we can never disagree on
// "where is network=N type=X key=Y stored on disk". Default network nests
// directly under CACHE_DIR (back-compat); others under CACHE_DIR/{network}/.
function pathFor(network: Network, type: string, key: string): string {
  const ext = type === "img" ? ".bin" : ".json";
  const base = network === DEFAULT_NETWORK ? CACHE_DIR : join(CACHE_DIR, network);
  return join(base, type, hashKey(key) + ext);
}

// Disk cache is permanent for immutable on-chain data (rows, meta, img).
// User data is mutable (profile updates, connections) so it still expires.
const DISK_TTL: Partial<Record<string, number>> = {
  user: 2 * 60 * 1000,    // 2 minutes — mutable profile/connection data
};

type CacheType = "meta" | "img" | "rows" | "user" | "render" | "view" | "site" | "site-file" | "signer-index" | "sns" | "ens" | "skillimg";

export async function getDiskCache(
  type: CacheType,
  key: string,
  network: Network = DEFAULT_NETWORK,
): Promise<Buffer | null> {
  const sk = storeKey(network, type, key);
  const entry = await getEntry(sk, DISK_TTL[type]);
  if (!entry) return null;
  // Try the stored path first (fast path for entries written this
  // process); fall back to the canonical pathFor() so caches imported
  // from a peer (where the stored path may be relative to a different
  // CACHE_DIR) still resolve.
  for (const path of [entry.path, pathFor(network, type, key)]) {
    try { return await readFile(path); } catch {}
  }
  await removeEntry(sk);
  return null;
}

export async function setDiskCache(
  type: CacheType,
  key: string,
  data: Buffer | string,
  network: Network = DEFAULT_NETWORK,
): Promise<void> {
  try {
    await ensureCacheDir(network, type);
    const filePath = pathFor(network, type, key);
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    await writeFile(filePath, buf);
    await recordEntry(storeKey(network, type, key), type, filePath, buf.length, network);
  } catch (err) {
    console.error("Disk cache write error:", err);
  }
}

