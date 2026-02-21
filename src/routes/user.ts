import { Hono } from "hono";
import { listUserAssets, listUserSessions, readUserState } from "../chain";
import { MemoryCache, userStateCache, TTL } from "../cache/memory";
import { getDiskCache, setDiskCache } from "../cache/disk";

export const userRouter = new Hono();

// ─── Caches ──────────────────────────────────────────────────────────────────

const assetsCache = new MemoryCache<string>(200);
const sessionsCache = new MemoryCache<string>(200);

const ASSETS_TTL = 2 * 60 * 1000;   // 2 min — inventory changes on new uploads
const SESSIONS_TTL = 5 * 60 * 1000; // 5 min — sessions rarely change

// ─── Inflight dedup ──────────────────────────────────────────────────────────

const inflight = new Map<string, Promise<string>>();

function deduped(key: string, fn: () => Promise<string>): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ─── GET /user/:pubkey/assets ────────────────────────────────────────────────

userRouter.get("/:pubkey/assets", async (c) => {
  const pubkey = c.req.param("pubkey");
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
  const before = c.req.query("before");
  const cacheKey = `assets:${pubkey}:${limit}:${before || ""}`;

  // Memory cache
  const mem = assetsCache.get(cacheKey);
  if (mem) return c.json(JSON.parse(mem));

  // Disk cache
  const disk = await getDiskCache("user", cacheKey);
  if (disk) {
    const json = disk.toString("utf8");
    assetsCache.set(cacheKey, json, ASSETS_TTL);
    return c.json(JSON.parse(json));
  }

  // Fetch from chain (deduplicated)
  try {
    const json = await deduped(cacheKey, async () => {
      const assets = await listUserAssets(pubkey, limit, before || undefined);
      return JSON.stringify(assets);
    });
    assetsCache.set(cacheKey, json, ASSETS_TTL);
    setDiskCache("user", cacheKey, json).catch(() => {});
    return c.json(JSON.parse(json));
  } catch {
    return c.json({ error: "failed to fetch assets" }, 500);
  }
});

// ─── GET /user/:pubkey/sessions ──────────────────────────────────────────────

userRouter.get("/:pubkey/sessions", async (c) => {
  const pubkey = c.req.param("pubkey");
  const cacheKey = `sessions:${pubkey}`;

  // Memory cache
  const mem = sessionsCache.get(cacheKey);
  if (mem) return c.json(JSON.parse(mem));

  // Disk cache
  const disk = await getDiskCache("user", cacheKey);
  if (disk) {
    const json = disk.toString("utf8");
    sessionsCache.set(cacheKey, json, SESSIONS_TTL);
    return c.json(JSON.parse(json));
  }

  // Fetch from chain (deduplicated)
  try {
    const json = await deduped(cacheKey, async () => {
      const sessions = await listUserSessions(pubkey);
      return JSON.stringify({ sessions });
    });
    sessionsCache.set(cacheKey, json, SESSIONS_TTL);
    setDiskCache("user", cacheKey, json).catch(() => {});
    return c.json(JSON.parse(json));
  } catch {
    return c.json({ error: "failed to fetch sessions" }, 500);
  }
});

// ─── GET /user/:pubkey/state ─────────────────────────────────────────────────

userRouter.get("/:pubkey/state", async (c) => {
  const pubkey = c.req.param("pubkey");
  const cacheKey = `user:${pubkey}`;

  // Memory cache
  const mem = userStateCache.get(cacheKey);
  if (mem) return c.json(JSON.parse(mem));

  // Disk cache
  const disk = await getDiskCache("user", pubkey);
  if (disk) {
    const json = disk.toString("utf8");
    userStateCache.set(cacheKey, json, TTL.USER_STATE);
    return c.json(JSON.parse(json));
  }

  // Fetch from chain (deduplicated)
  try {
    const json = await deduped(cacheKey, async () => {
      const state = await readUserState(pubkey);
      return JSON.stringify(state, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    });
    userStateCache.set(cacheKey, json, TTL.USER_STATE);
    setDiskCache("user", pubkey, json).catch(() => {});
    return c.json(JSON.parse(json));
  } catch {
    return c.json({ error: "failed to fetch state" }, 500);
  }
});
