import { Hono } from "hono";
import { listUserAssets, listUserSessions, readUserState } from "../chain";
import { userStateCache, TTL, getDiskCache, setDiskCache } from "../cache";

export const userRouter = new Hono();

// Inflight dedup for user state fetches
const inflight = new Map<string, Promise<string>>();

function deduped(key: string, fn: () => Promise<string>): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// GET /user/:pubkey/assets - List user's uploaded assets
userRouter.get("/:pubkey/assets", async (c) => {
  const pubkey = c.req.param("pubkey");
  const limit = Number(c.req.query("limit")) || 20;
  const before = c.req.query("before");

  try {
    const assets = await listUserAssets(pubkey, limit, before || undefined);
    return c.json(assets);
  } catch (e) {
    return c.json({ error: "failed to fetch assets" }, 500);
  }
});

// GET /user/:pubkey/sessions - List user's session PDAs
userRouter.get("/:pubkey/sessions", async (c) => {
  const pubkey = c.req.param("pubkey");

  try {
    const sessions = await listUserSessions(pubkey);
    return c.json({ sessions });
  } catch (e) {
    return c.json({ error: "failed to fetch sessions" }, 500);
  }
});

// GET /user/:pubkey/state - Get user state (memory → disk → chain)
userRouter.get("/:pubkey/state", async (c) => {
  const pubkey = c.req.param("pubkey");
  const cacheKey = `user:${pubkey}`;

  // Check memory cache
  const mem = userStateCache.get(cacheKey);
  if (mem) {
    return c.json(JSON.parse(mem));
  }

  // Check disk cache
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
  } catch (e) {
    return c.json({ error: "failed to fetch state" }, 500);
  }
});
