import { Hono } from "hono";
import pkg from "../../package.json" with { type: "json" };
import { metaCache, imageCache, userStateCache } from "../cache/memory";
import { snsCache, snsInflight } from "../chain/solana/sns";
import { getStats } from "../cache/store";
import { getRpcMetrics } from "../chain/solana";
import { rowsCache, indexCache, sliceCache, inflight } from "./table";

export const healthRouter = new Hono();

// Version comes from package.json so we never have to remember to bump
// two files. process.env.VERSION still wins (lets ops override at runtime).
const VERSION = process.env.VERSION || pkg.version;
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
    rpc: getRpcMetrics(),
    cache: {
      memory: {
        meta: metaCache.size(),
        images: imageCache.size(),
        userState: userStateCache.size(),
        tableRows: rowsCache.size(),
        tableIndex: indexCache.size(),
        tableSlice: sliceCache.size(),
        inflightReads: inflight.size,
        sns: snsCache.size(),
        snsInflight: snsInflight.size,
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
