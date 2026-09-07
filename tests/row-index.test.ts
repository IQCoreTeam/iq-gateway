import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

// Isolated cache dir for this test file (set before importing the cache layer).
const TEST_DIR = `/tmp/iq-row-index-test-${process.pid}`;
process.env.CACHE_DIR = TEST_DIR;

const {
  recordRows, listIndexedRows, countIndexedRows,
  getIndexState, setIndexState, rowIndexStats,
} = await import("../src/cache/row-index");
const { initCacheStore } = await import("../src/cache/store");

await initCacheStore();

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

const T = { network: "robinhood", dbroot: "iqchan", tableName: "biz" };

describe("evm_row_index — durable row enumeration", () => {
  test("records and orders newest-first: pending (no block) on top, then block desc", async () => {
    await recordRows([
      { ...T, txHash: "0xaa", blockNumber: 100, logIndex: 2 },
      { ...T, txHash: "0xbb", blockNumber: 200, logIndex: 1 },
      { ...T, txHash: "0xcc", blockNumber: null },
      { ...T, txHash: "0xdd", blockNumber: 200, logIndex: 5 },
    ]);
    const rows = await listIndexedRows(T.network, T.dbroot, T.tableName, { limit: 10 });
    expect(rows.map((r) => r.tx_hash)).toEqual(["0xcc", "0xdd", "0xbb", "0xaa"]);
  });

  test("before cursor paginates past the cursor row", async () => {
    const page = await listIndexedRows(T.network, T.dbroot, T.tableName, { limit: 2, before: "0xdd" });
    expect(page.map((r) => r.tx_hash)).toEqual(["0xbb", "0xaa"]);
  });

  test("unknown before cursor serves from the head", async () => {
    const page = await listIndexedRows(T.network, T.dbroot, T.tableName, { limit: 1, before: "0xnope" });
    expect(page[0].tx_hash).toBe("0xcc");
  });

  test("upsert fills gaps but never blanks known facts", async () => {
    // Hydration writes row_json without block info...
    await recordRows([{ ...T, txHash: "0xaa", rowJson: '{"com":"hi"}' }]);
    // ...and a later log-scan entry (no payload) must not erase it.
    await recordRows([{ ...T, txHash: "0xaa", blockNumber: 100, logIndex: 2, signer: "0xME" }]);
    const rows = await listIndexedRows(T.network, T.dbroot, T.tableName, { limit: 10 });
    const aa = rows.find((r) => r.tx_hash === "0xaa");
    expect(aa?.row_json).toBe('{"com":"hi"}');
    expect(aa?.block_number).toBe(100);
    expect(aa?.signer).toBe("0xME");
  });

  test("tables are isolated by (network, dbroot, table)", async () => {
    await recordRows([{ network: "monad", dbroot: "iqchan", tableName: "biz", txHash: "0xaa", blockNumber: 1 }]);
    expect(await countIndexedRows(T.network, T.dbroot, T.tableName)).toBe(4);
    expect(await countIndexedRows("monad", "iqchan", "biz")).toBe(1);
  });

  test("index state round-trips and reports in stats", async () => {
    expect(await getIndexState(T.network, T.dbroot, T.tableName)).toBeNull();
    await setIndexState(T.network, T.dbroot, T.tableName, { syncedFromBlock: 0, syncedToBlock: 500, complete: true });
    expect(await getIndexState(T.network, T.dbroot, T.tableName)).toEqual({
      syncedFromBlock: 0, syncedToBlock: 500, complete: true,
    });
    const stats = await rowIndexStats();
    expect(stats.rows).toBe(5);
    expect(stats.tables).toBe(2);
    expect(stats.backfilledTables).toBe(1);
  });
});
