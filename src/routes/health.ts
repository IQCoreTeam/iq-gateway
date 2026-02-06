import { Hono } from "hono";
import { metaCache, imageCache, getStats } from "../cache";
import { rowsCache, inflight } from "./table";

export const healthRouter = new Hono();

const VERSION = process.env.VERSION || "0.1.0";
const START_TIME = Date.now();

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

healthRouter.get("/health", async (c) => {
  const diskStats = await getStats();

  return c.json({
    status: "ok",
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    cache: {
      memory: {
        meta: metaCache.size(),
        images: imageCache.size(),
        tableRows: rowsCache.size(),
        inflightReads: inflight.size,
      },
      disk: {
        entries: diskStats.entryCount,
        size: formatBytes(diskStats.totalSize),
        maxSize: formatBytes(diskStats.maxSize),
        usagePercent: Math.round(diskStats.usagePercent * 10) / 10,
      },
    },
  });
});

healthRouter.get("/version", (c) => {
  return c.json({ version: VERSION });
});
