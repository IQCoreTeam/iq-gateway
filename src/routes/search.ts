// Read-only catalog search. Backed by the FTS5 virtual table in cache.db;
// the index is populated by catalog-ingest (backfill on boot + /notify hook).
//
// Query syntax is FTS5 native — callers can pass plain words (auto-prefixed
// as "type as you go") or compound expressions (phrase, AND/OR/NOT). Empty
// query returns hits=[]; never 4xxs for shape, so the search UI can call
// this on every keystroke.

import { Hono } from "hono";
import { searchCatalog, catalogStats, type CatalogEntry } from "../cache/catalog";

export const searchRouter = new Hono();

searchRouter.get("/", async (c) => {
  const q = c.req.query("q") ?? "";
  const kindParam = c.req.query("kind");
  const limit = Number(c.req.query("limit"));
  // Optional network filter. Without it, search spans every network (global
  // catalog); with `?network=monad` it scopes to that network — matching how
  // the data routes resolve. An unknown value just yields no hits (search never
  // 4xxs on shape), so no validation here.
  const network = c.req.query("network") || undefined;

  const kind: CatalogEntry["kind"] | undefined =
    kindParam === "dbroot" || kindParam === "table" || kindParam === "row"
      ? kindParam
      : undefined;

  const hits = await searchCatalog(q, {
    kind,
    network,
    limit: Number.isFinite(limit) ? limit : undefined,
  });
  return c.json({ q, ...(network && { network }), hits, count: hits.length });
});

searchRouter.get("/stats", async (c) => {
  const stats = await catalogStats();
  return c.json(stats);
});
