import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readTableRows } from "../chain";
import { MemoryCache } from "../cache/memory";

export const tableRouter = new Hono();

// Cache for table rows - short TTL since data is mutable
const rowsCache = new MemoryCache<string>(100);
const ROWS_TTL = 30 * 1000; // 30 seconds

function isValidPublicKey(key: string): boolean {
  try {
    new PublicKey(key);
    return true;
  } catch {
    return false;
  }
}

function getCacheKey(tablePda: string, limit: number, before?: string): string {
  const raw = `${tablePda}:${limit}:${before || ""}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// GET /table/:tablePda/rows - Read rows from a table PDA
tableRouter.get("/:tablePda/rows", async (c) => {
  const tablePda = c.req.param("tablePda");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 100);
  const before = c.req.query("before") || undefined;
  const fresh = c.req.query("fresh") === "true";

  if (!isValidPublicKey(tablePda)) {
    return c.json({ error: "invalid table PDA" }, 400);
  }

  const cacheKey = getCacheKey(tablePda, limit, before);

  // Check cache unless fresh requested
  if (!fresh) {
    const cached = rowsCache.get(cacheKey);
    if (cached) {
      return c.json({
        ...JSON.parse(cached),
        cached: true,
      });
    }
  }

  try {
    const rows = await readTableRows(tablePda, { limit, before });

    const response = {
      tablePda,
      rows,
      count: rows.length,
      limit,
      before: before || null,
      nextCursor: rows.length === limit ? rows[rows.length - 1]?.__txSignature : null,
    };

    // Cache the result
    rowsCache.set(cacheKey, JSON.stringify(response), ROWS_TTL);

    return c.json({ ...response, cached: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";

    if (message.includes("not found") || message.includes("Invalid public key")) {
      return c.json({ error: "table not found", tablePda }, 404);
    }

    console.error(`[table] failed to read ${tablePda}:`, message);
    return c.json({ error: "failed to read table" }, 500);
  }
});

// GET /table/cache/stats - Cache statistics
tableRouter.get("/cache/stats", (c) => {
  return c.json({
    entries: rowsCache.size(),
    ttl: ROWS_TTL,
  });
});

// Export cache for health endpoint
export { rowsCache };
