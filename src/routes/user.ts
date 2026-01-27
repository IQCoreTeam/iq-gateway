import { Hono } from "hono";
import { listUserAssets, listUserSessions, readUserState } from "../chain";

export const userRouter = new Hono();

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

// GET /user/:pubkey/state - Get user state
userRouter.get("/:pubkey/state", async (c) => {
  const pubkey = c.req.param("pubkey");

  try {
    const state = await readUserState(pubkey);
    return c.json(state);
  } catch (e) {
    return c.json({ error: "failed to fetch state" }, 500);
  }
});
