import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The cache modules hold process-wide DB/path singletons. All cache tests in
// one Bun process must share their lifetime, even when files run in a new order.
const root = mkdtempSync(join(tmpdir(), "iq-gateway-tests-"));
export const CACHE_DIR = join(root, "cache");
process.env.CACHE_DIR = CACHE_DIR;
const { getDb } = await import("../../src/cache/store");
const db = await getDb();

// File-level afterAll runs while later files still use this database. Close it
// only at process exit, then remove only the temporary tree this fixture owns.
process.once("exit", () => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
