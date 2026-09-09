import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { EvmWrapper } from "../src/chain/wrappers";

import "./helpers/cache-fixture";

// The route module pulls in catalog ingest (FTS5 sqlite + reader backfill
// wiring) and the log backfill scheduler at load; these tests exercise
// paging, not the search index or the backfill.
mock.module("../src/cache/catalog-ingest.evm", () => ({
  ingestRow: async () => {},
}));
mock.module("../src/chain/evm/log-index", () => ({ scheduleTableBackfill() {} }));

const { tableRouter, rowsCache, indexCache, sliceCache, inflight } = await import("../src/routes/evm/table");
const { recordRows, setIndexState } = await import("../src/cache/row-index");

const DB_ROOT = "testroot";
const TABLE = "posts";

type Row = Record<string, unknown>;

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
// Decoded JSON-object row: carries `__txHash` (formatRow in chain/evm/reader.ts).
const row = (n: number): Row => ({ __txHash: hash(n), value: n });
// Failed/undecodable tx: formatRow keeps its hash under plain `txHash` only.
const badRow = (n: number): Row => ({ txHash: hash(n), metadata: "", data: null });
const rowHash = (r: Row) => (r as { __txHash?: string; txHash?: string }).__txHash ?? (r as { txHash?: string }).txHash;

// Fake wrapper injected via ctx (the EVM route reads `c.get("chain")`), shaped
// like the gateway reader's readTableRows output: one row per walked tx,
// newest first, honoring the requested limit.
let history: Row[] = [];
let metaResponses: Array<{ lastTimestamp: number }> = [];

const fakeChain = {
  readTableRows: async (_dbRootId: string, _tableName: string, opts?: { limit?: number }) =>
    history.slice(0, opts?.limit ?? history.length).map((r) => ({ ...r })),
  getTableMetaCached: async () => metaResponses.shift() ?? { lastTimestamp: 1 },
  readSingleRow: async () => null,
} as unknown as EvmWrapper;

const app = new Hono<{ Variables: { chain: EvmWrapper; network: string } }>();
app.use("*", async (c, next) => {
  c.set("chain", fakeChain);
  c.set("network", "sepolia");
  await next();
});
app.route("/", tableRouter);

beforeEach(() => {
  history = [];
  metaResponses = [];
  rowsCache.clear();
  indexCache.clear();
  sliceCache.clear();
  inflight.clear();
});

describe("/table/:dbRootId/:tableName/rows cursor", () => {
  test("failed tx at the page bottom derives nextCursor from the walk position", async () => {
    // hash(4) is a failed/undecodable tx mid-history: the walk returns it but
    // its row has no `__txHash` (only plain `txHash`). It lands at the bottom
    // of a full page, so a shape-based cursor would come back empty and paging
    // clients would treat the page as the end, permanently skipping rows 5-6.
    history = [row(1), row(2), row(3), badRow(4), row(5), row(6)];
    metaResponses.push({ lastTimestamp: 1 });

    const first = await app.request(`/${DB_ROOT}/${TABLE}/rows?limit=4`);
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.rows.map(rowHash)).toEqual([hash(1), hash(2), hash(3), hash(4)]);
    expect(firstBody.count).toBe(4);
    expect(firstBody.nextCursor).toBe(hash(4));

    // The cursor points at the undecodable tx: the `before` lookup must match
    // its plain `txHash` too, or this page would silently re-serve the head.
    const second = await app.request(`/${DB_ROOT}/${TABLE}/rows?limit=4&before=${firstBody.nextCursor}`);
    const secondBody = await second.json();
    expect(secondBody.rows.map(rowHash)).toEqual([hash(5), hash(6)]);
    // Short page that consumed the walk to its end: history really is exhausted.
    expect(secondBody.nextCursor).toBeNull();
  });

  test("index path derives nextCursor from the index page, not the hydrated rows", async () => {
    // Once the log backfill marks a table complete, `before` pages come from
    // the durable index. hydrateIndexedRows drops txs the index has confirmed
    // non-decodable, so a page whose indexed entries include one serves fewer
    // than `limit` rows; a count-based cursor concluded end-of-history there
    // and everything older was unreachable. 20 indexed txs at limit=4 with
    // 4, 9, 14 and 19 non-decodable: paging must continue until the index
    // itself runs out. Own table name: the index is keyed per table.
    const indexTable = "posts-index";
    history = [row(1), row(2), row(3), badRow(4)];
    metaResponses.push({ lastTimestamp: 1 });
    await recordRows(Array.from({ length: 20 }, (_, i) => ({
      network: "sepolia", dbroot: DB_ROOT, tableName: indexTable, txHash: hash(i + 1),
      blockNumber: 1000 - i, rowJson: i % 5 === 3 ? "null" : JSON.stringify(row(i + 1)),
    })));
    await setIndexState("sepolia", DB_ROOT, indexTable, { syncedFromBlock: 0, syncedToBlock: 1000, complete: true });

    const seen: string[] = [];
    const counts: number[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const res = await app.request(`/${DB_ROOT}/${indexTable}/rows?limit=4${cursor ? `&before=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      counts.push(body.count);
      seen.push(...body.rows.map(rowHash));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    // The head page walks (4 rows, the undecodable tx included); the index
    // then serves a 3-row page wherever it dropped a non-decodable tx and the
    // cursor still advances; the last page is empty because the index ran out.
    expect(counts).toEqual([4, 4, 3, 3, 3, 0]);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 18, 20].map(hash));
  });

  test("notify refill with an undecodable bottom row falls back to its plain txHash", async () => {
    // The table starts one row short of `limit` with an undecodable tx at the
    // bottom. A /notify prepend refills the page to `limit`; the rebuilt
    // cursor must fall back to that row's plain `txHash` instead of nulling
    // out on its shape and cutting off all older history.
    history = [row(1), row(2), row(3), badRow(4)];
    metaResponses.push({ lastTimestamp: 1 });

    const first = await app.request(`/${DB_ROOT}/${TABLE}/rows?limit=5`);
    const firstBody = await first.json();
    expect(firstBody.count).toBe(4);
    // Walk exhausted below limit: genuinely the whole history.
    expect(firstBody.nextCursor).toBeNull();

    const notified = await app.request(`/${DB_ROOT}/${TABLE}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: hash(7), row: { value: "new" } }),
    });
    expect(notified.status).toBe(200);

    const cached = await app.request(`/${DB_ROOT}/${TABLE}/rows?limit=5`);
    const body = await cached.json();
    expect(body.cached).toBe(true);
    expect(body.count).toBe(5);
    expect(body.rows.map(rowHash)).toEqual([hash(7), hash(1), hash(2), hash(3), hash(4)]);
    expect(body.nextCursor).toBe(hash(4));
  });
});
