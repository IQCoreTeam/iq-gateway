import { Hono } from "hono";
import { metaCache, imageCache } from "../cache";

export const healthRouter = new Hono();

const VERSION = process.env.VERSION || "0.1.0";
const START_TIME = Date.now();

healthRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    cache: {
      meta: metaCache.size(),
      images: imageCache.size(),
    },
  });
});

healthRouter.get("/version", (c) => {
  return c.json({ version: VERSION });
});
