// /admin/* — operator-only tunables and ops actions.
//
// Mounted only when ADMIN_TOKEN is set; otherwise the routes don't exist at
// all (safer than a missing-token check that could be misconfigured to
// allow everything). Bearer auth via Authorization header.

import { Hono } from "hono";
import { getQueueStats, setQueueConfig } from "../chain/rpc-queue";
import { isNetworkMode } from "../chain/evm/networks";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

export function checkAdminAuth(authHeader: string | undefined): boolean {
  const presented = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return !!ADMIN_TOKEN && presented === ADMIN_TOKEN;
}

export const adminRouter = new Hono();

adminRouter.use("*", async (c, next) => {
  if (!checkAdminAuth(c.req.header("authorization"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

adminRouter.get("/queue", (c) => {
  return c.json(getQueueStats());
});

adminRouter.post("/queue", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "expected object body" }, 400);

  const patch = body as Record<string, unknown>;
  const allowed = ["concurrency", "minTimeMs", "maxDepth"] as const;
  const update: Partial<Record<typeof allowed[number], number>> = {};
  for (const key of allowed) {
    if (key in patch) {
      const v = patch[key];
      if (typeof v !== "number") return c.json({ error: `${key} must be a number` }, 400);
      update[key] = v;
    }
  }

  try {
    const next = setQueueConfig(update);
    return c.json({ config: next, applied: update });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "invalid config" }, 400);
  }
});

// ─── Durable EVM row index ops ───────────────────────────────────────────────
// GET  /admin/evm-index?network=&dbroot=&table=   → backfill state + row count
// POST /admin/evm-index {network, dbroot, table}  → run a backfill now

function evmIndexParams(network: unknown, dbroot: unknown, table: unknown):
  { network: string; dbroot: string; table: string } | { error: string } {
  if (typeof network !== "string" || !isNetworkMode(network)) return { error: "valid network required" };
  if (typeof dbroot !== "string" || !dbroot) return { error: "dbroot required" };
  if (typeof table !== "string" || !table) return { error: "table required" };
  return { network, dbroot, table };
}

adminRouter.get("/evm-index", async (c) => {
  const p = evmIndexParams(c.req.query("network"), c.req.query("dbroot"), c.req.query("table"));
  if ("error" in p) return c.json({ error: p.error }, 400);
  const { getIndexState, countIndexedRows } = await import("../cache/row-index");
  const [state, count] = await Promise.all([
    getIndexState(p.network, p.dbroot, p.table),
    countIndexedRows(p.network, p.dbroot, p.table),
  ]);
  return c.json({ ...p, state, indexedRows: count });
});

adminRouter.post("/evm-index", async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid JSON body" }, 400); }
  const p = evmIndexParams(body.network, body.dbroot, body.table);
  if ("error" in p) return c.json({ error: p.error }, 400);
  const { runTableBackfill } = await import("../chain/evm/log-index");
  const { buildEvmWrapper } = await import("../chain/wrappers");
  try {
    const wrapper = buildEvmWrapper(p.network as Parameters<typeof buildEvmWrapper>[0]);
    const result = await runTableBackfill(
      { network: p.network, getProvider: wrapper.getProvider, config: wrapper.config },
      p.dbroot, p.table,
    );
    return c.json({ ...p, ...result });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "backfill failed" }, 500);
  }
});

export function isAdminEnabled(): boolean {
  return !!ADMIN_TOKEN;
}
