import { Hono } from "hono";
import { MemoryCache, userStateCache, TTL, getDiskCache, setDiskCache, deduped } from "../../cache";
import { isEvmAddress } from "../../utils";
import type { EvmEnv } from "../../chain/wrappers";

export const userRouter = new Hono<EvmEnv>();

const assetsCache = new MemoryCache<string>(200);
const ASSETS_TTL = 2 * 60 * 1000;
const inflight = new Map<string, Promise<string>>();

export function invalidateUserAssets(addr: string) {
  const lower = addr.toLowerCase();
  for (const key of assetsCache.keys()) {
    // keys are `${network}:assets:${lower}:...` — match the addr across networks.
    if (key.includes(`assets:${lower}:`)) assetsCache.delete(key);
  }
}

userRouter.get("/:address/assets", async (c) => {
  const address = c.req.param("address");
  if (!isEvmAddress(address)) return c.json({ error: "invalid address" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");
  const lower = address.toLowerCase();
  const limit = Math.min(Number(c.req.query("limit")) || 20, 100);
  const before = c.req.query("before");
  const diskKey = `assets:${lower}:${limit}:${before || ""}`;
  const cacheKey = `${network}:${diskKey}`;

  const mem = assetsCache.get(cacheKey);
  if (mem) return c.json(JSON.parse(mem));

  const disk = await getDiskCache("user", diskKey, network);
  if (disk) {
    const json = disk.toString("utf8");
    assetsCache.set(cacheKey, json, ASSETS_TTL);
    return c.json(JSON.parse(json));
  }

  try {
    const json = await deduped(inflight, cacheKey, async () => {
      const assets = await chain.listUserAssets(address, limit, before || undefined);
      return JSON.stringify(assets);
    });
    assetsCache.set(cacheKey, json, ASSETS_TTL);
    setDiskCache("user", diskKey, json, network).catch(() => {});
    return c.json(JSON.parse(json));
  } catch (e) {
    console.error("[/user/assets] failed:", e instanceof Error ? e.message : e);
    return c.json({ error: "failed to fetch assets" }, 500);
  }
});

// Sessions are a Solana-specific PDA concept with no EVM equivalent.
// Return empty list for API parity so clients don't need feature detection.
userRouter.get("/:address/sessions", (c) => {
  const address = c.req.param("address");
  if (!isEvmAddress(address)) return c.json({ error: "invalid address" }, 400);
  return c.json({ sessions: [], note: "sessions not applicable on EVM chains" });
});

userRouter.get("/:address/profile", async (c) => {
  const address = c.req.param("address");
  if (!isEvmAddress(address)) return c.json({ error: "invalid address" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");
  const lower = address.toLowerCase();
  const diskKey = `profile:${lower}`;
  const cacheKey = `${network}:${diskKey}`;

  const mem = userStateCache.get(cacheKey);
  if (mem) return c.json(JSON.parse(mem));

  const disk = await getDiskCache("user", diskKey, network);
  if (disk) {
    const json = disk.toString("utf8");
    userStateCache.set(cacheKey, json, TTL.USER_STATE);
    return c.json(JSON.parse(json));
  }

  try {
    const json = await deduped(inflight, cacheKey, async () => {
      const state = await chain.readUserState(address);
      if (!state?.metadata) return JSON.stringify({ address });
      try {
        const profile = JSON.parse(state.metadata);
        return JSON.stringify({ address, ...profile });
      } catch {
        return JSON.stringify({ address, metadata: state.metadata });
      }
    });
    userStateCache.set(cacheKey, json, TTL.USER_STATE);
    setDiskCache("user", diskKey, json, network).catch(() => {});
    return c.json(JSON.parse(json));
  } catch {
    return c.json({ address }, 200);
  }
});

userRouter.get("/:address/state", async (c) => {
  const address = c.req.param("address");
  if (!isEvmAddress(address)) return c.json({ error: "invalid address" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");
  const lower = address.toLowerCase();
  const diskKey = `user:${lower}`;
  const cacheKey = `${network}:${diskKey}`;

  const mem = userStateCache.get(cacheKey);
  if (mem) return c.json(JSON.parse(mem));

  const disk = await getDiskCache("user", diskKey, network);
  if (disk) {
    const json = disk.toString("utf8");
    userStateCache.set(cacheKey, json, TTL.USER_STATE);
    return c.json(JSON.parse(json));
  }

  try {
    const json = await deduped(inflight, cacheKey, async () => {
      const state = await chain.readUserState(address);
      return JSON.stringify(state, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    });
    userStateCache.set(cacheKey, json, TTL.USER_STATE);
    setDiskCache("user", diskKey, json, network).catch(() => {});
    return c.json(JSON.parse(json));
  } catch {
    return c.json({ error: "failed to fetch state" }, 500);
  }
});

userRouter.get("/:address/posts", async (c) => {
  const address = c.req.param("address");
  if (!isEvmAddress(address)) return c.json({ error: "invalid address" }, 400);
  const chain = c.get("chain");
  const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
  const hashes = await chain.getSignerSigs(address, limit);
  return c.json({ address, txHashes: hashes, count: hashes.length, note: "opportunistic index" });
});

const connectionsCache = new MemoryCache<string>(200);
const CONNECTIONS_TTL = 60 * 1000;

userRouter.get("/:address/connections", async (c) => {
  const address = c.req.param("address");
  if (!isEvmAddress(address)) return c.json({ error: "invalid address" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");
  const lower = address.toLowerCase();
  const diskKey = `connections:${lower}`;
  const cacheKey = `${network}:${diskKey}`;

  const mem = connectionsCache.get(cacheKey);
  if (mem) return c.json(JSON.parse(mem));

  const disk = await getDiskCache("user", diskKey, network);
  if (disk) {
    const json = disk.toString("utf8");
    connectionsCache.set(cacheKey, json, CONNECTIONS_TTL);
    return c.json(JSON.parse(json));
  }

  try {
    const json = await deduped(inflight, cacheKey, async () => {
      const connections = await chain.fetchUserConnections(address);
      return JSON.stringify(connections);
    });
    connectionsCache.set(cacheKey, json, CONNECTIONS_TTL);
    setDiskCache("user", diskKey, json, network).catch(() => {});
    return c.json(JSON.parse(json));
  } catch {
    return c.json({ error: "failed to fetch connections" }, 500);
  }
});
