import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The cache modules hold process-wide DB/path singletons. All cache tests in
// one Bun process must share their lifetime, even when files run in a new order.
// bunfig.toml preloads this file, so CACHE_DIR is already set when any module
// binds it at load; test files must not assign process.env.CACHE_DIR themselves.
const root = mkdtempSync(join(tmpdir(), "iq-gateway-tests-"));
export const CACHE_DIR = join(root, "cache");
process.env.CACHE_DIR = CACHE_DIR;
const { getDb } = await import("../../src/cache/store");
const db = await getDb();

// A preload's afterAll runs once after every file (bun test does not fire
// process "exit" handlers). Close the shared database, then remove only the
// temporary tree this fixture owns.
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
