// /admin/* — operator-only tunables and ops actions.
//
// Mounted only when ADMIN_TOKEN is set; otherwise the routes don't exist at
// all (safer than a missing-token check that could be misconfigured to
// allow everything). Bearer auth via Authorization header.

import { Hono } from "hono";
import { getQueueStats, setQueueConfig } from "../chain/rpc-queue";

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

export function isAdminEnabled(): boolean {
  return !!ADMIN_TOKEN;
}
