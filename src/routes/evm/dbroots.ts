// /dbroots — list DbRoots known to this gateway.
//
// Ethereum doesn't expose Solana-style getProgramAccounts; we maintain a
// seed file (config/known-dbroots.json) and grow it as the catalog observes
// new dbRootIds in row payloads. Each entry is hydrated via the SDK's
// getTablelistFromRoot for fresh table lists.

import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { id as keccak } from "ethers";
import { getTablelistFromRoot } from "../../chain/evm";
import { MemoryCache } from "../../cache";

export const dbrootsRouter = new Hono();

interface DbRootSeed {
  /** Human-readable dbRootId string (the SDK keccak's it). */
  id: string;
}

export interface TableEntry {
  name: string;
  seedHex: string;
}

export interface DbRootEntry {
  /** Human-readable id (seed input). */
  id: string;
  /** keccak256(id) — on-chain mapping key. */
  seedHex: string;
  creator: string | null;
  tables: TableEntry[];
  globalTables: TableEntry[];
}

export interface DbRootsPayload {
  dbroots: DbRootEntry[];
  fetchedAt: number;
  count: number;
}

const cache = new MemoryCache<string>(1);
const TTL_MS = 30 * 60 * 1000;
const CACHE_KEY = "dbroots:all";
let inflight: Promise<DbRootsPayload> | null = null;

const SEED_FILE = process.env.KNOWN_DBROOTS_FILE || "./config/known-dbroots.json";
const dynamicSeeds = new Set<string>();

/** Called by catalog ingest when a new dbRootId is seen in a row payload. */
export function noteDbRootId(id: string): void {
  if (id && typeof id === "string") dynamicSeeds.add(id);
}

async function loadSeedFile(): Promise<DbRootSeed[]> {
  try {
    const text = await readFile(SEED_FILE, "utf8");
    const parsed = JSON.parse(text) as { dbroots?: DbRootSeed[] };
    return Array.isArray(parsed.dbroots) ? parsed.dbroots : [];
  } catch {
    return [];
  }
}

async function fetchAllDbRoots(): Promise<DbRootsPayload> {
  const seeds = await loadSeedFile();
  const ids = new Set<string>([
    ...seeds.map((s) => s.id),
    ...dynamicSeeds,
  ]);

  const dbroots: DbRootEntry[] = [];
  for (const id of ids) {
    try {
      const root = await getTablelistFromRoot(id);
      dbroots.push({
        id,
        seedHex: keccak(id),
        creator: root.creator ?? null,
        tables: root.tables,
        globalTables: root.globalTables,
      });
    } catch (e) {
      console.warn(`[dbroots] skipping ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  dbroots.sort((a, b) => a.id.localeCompare(b.id));

  return {
    dbroots,
    fetchedAt: Date.now(),
    count: dbroots.length,
  };
}

export async function getCachedDbRoots(): Promise<DbRootsPayload> {
  const cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached) as DbRootsPayload;

  if (!inflight) {
    inflight = (async () => {
      try { return await fetchAllDbRoots(); }
      finally { inflight = null; }
    })();
  }
  const payload = await inflight;
  cache.set(CACHE_KEY, JSON.stringify(payload), TTL_MS);
  return payload;
}

dbrootsRouter.get("/", async (c) => {
  try {
    return c.json(await getCachedDbRoots());
  } catch (e) {
    console.error("[dbroots] failed:", e instanceof Error ? e.message : e);
    return c.json({ error: "failed to read DbRoots" }, 500);
  }
});
