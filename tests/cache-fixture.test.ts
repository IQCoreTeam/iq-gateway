// Loads the cache modules before this file's fixture import on purpose. They
// bind CACHE_DIR at module load, so when this file is the first to load them
// the assertions hold only because bunfig.toml preloads the fixture ahead of
// every test file, whatever order bun runs them in.
import { getDb } from "../src/cache/store";
import { setDiskCache } from "../src/cache/disk";
import { cacheRouter } from "../src/routes/cache-snapshot";
import { CACHE_DIR } from "./helpers/cache-fixture";
import { expect, test } from "bun:test";
import { join } from "node:path";

test("cache modules loaded before the fixture still bind its CACHE_DIR", async () => {
  expect(process.env.CACHE_DIR).toBe(CACHE_DIR);
  expect((await getDb()).filename).toBe(join(CACHE_DIR, "cache.db"));

  await setDiskCache("rows", "cache-fixture-order", "{}");
  const res = await cacheRouter.request("/entries?type=rows&q=cache-fixture-order");
  expect(res.status).toBe(200);
  expect((await res.json()).entries.map((e: { cacheKey: string }) => e.cacheKey)).toEqual(["cache-fixture-order"]);
});
