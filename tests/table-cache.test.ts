import { beforeEach, describe, expect, mock, test } from "bun:test";

import "./helpers/cache-fixture";

const TABLE_PDA = "11111111111111111111111111111111";
// Disk cache (CACHE_DIR) persists across tests in this file and /rows pages
// are keyed by (tablePda, limit, before); tests that must cold-fetch use a
// separate PDA (or a unique limit) so an earlier test's disk page can't be
// served in place of a fresh fetch.
const GAP_TABLE_PDA = "So11111111111111111111111111111111111111112";

type Row = Record<string, unknown> & { __txSignature: string };
type Meta = {
  name: string;
  columns: string[];
  idCol: string;
  lastTimestamp: number;
  gate: null;
};

let signatures: string[] = [];
let rowsBySig = new Map<string, Row>();
let metaResponses: Array<Meta | Promise<Meta>> = [];
let signatureFetches: Array<{ limit: number; before?: string }> = [];
// When set, fetchRecentSignatures blocks until the promise resolves;
// simulates in-flight RPC latency for background-refresh race tests.
let signatureGate: Promise<void> | null = null;

const meta = (lastTimestamp: number): Meta => ({
  name: "test",
  columns: [],
  idCol: "id",
  lastTimestamp,
  gate: null,
});

mock.module("../src/chain/solana", () => ({
  readAsset: async () => null,
  listUserAssets: async () => [],
  listUserSessions: async () => [],
  readUserState: async () => null,
  fetchUserConnections: async () => [],
  fetchSignatureIndex: async () => [],
  readRowsBySignatures: async (sigs: string[]) => sigs.map((sig) => rowsBySig.get(sig)).filter(Boolean),
  fetchRecentSignatures: async (_tablePda: string, limit = 50, before?: string) => {
    if (signatureGate) await signatureGate;
    signatureFetches.push({ limit, before });
    const start = before ? signatures.indexOf(before) + 1 : 0;
    return signatures.slice(start, start + limit);
  },
  readMultipleRows: async (sigs: string[]) => new Map(sigs.map((sig) => [sig, rowsBySig.get(sig) ?? null])),
  readSingleRow: async (sig: string) => rowsBySig.get(sig) ?? null,
  generateETag: () => "etag",
  decodeAssetData: () => ({ data: null, metadata: null }),
  detectImageType: () => "application/octet-stream",
  getRpcMetrics: () => ({ totalCalls: 0, rateLimited: 0, errors: 0, fallbacks: 0, heliusCalls: 0, heliusEnabled: false }),
  isHeliusEnabled: () => false,
  HELIUS_RPC: null,
  heliusGetTransactionsForAddress: async () => [],
  getSignerSigs: async () => [],
  readTableMeta: async () => meta(1),
  getTableMetaCached: async () => {
    const next = metaResponses.shift();
    return next ? await next : meta(1);
  },
}));

const { tableRouter, rowsCache, indexCache, sliceCache, inflight, lastRefresh } = await import("../src/routes/table");

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(check()).toBe(true);
}

beforeEach(() => {
  signatures = [];
  rowsBySig = new Map();
  metaResponses = [];
  signatureFetches = [];
  signatureGate = null;
  rowsCache.clear();
  indexCache.clear();
  sliceCache.clear();
  inflight.clear();
  lastRefresh.clear();
});

describe("/table/:pda/rows cache refresh", () => {
  test("notify keeps cached head page capped at the requested limit", async () => {
    signatures = ["sig-a", "sig-b", "sig-c", "sig-d", "sig-e"];
    rowsBySig = new Map([
      ["sig-a", { __txSignature: "sig-a", value: "a" }],
      ["sig-b", { __txSignature: "sig-b", value: "b" }],
      ["sig-c", { __txSignature: "sig-c", value: "c" }],
      ["sig-d", { __txSignature: "sig-d", value: "d" }],
      ["sig-e", { __txSignature: "sig-e", value: "e" }],
    ]);
    metaResponses.push(meta(1));

    const first = await tableRouter.request(`/${TABLE_PDA}/rows?limit=5`);
    expect(first.status).toBe(200);
    expect((await first.json()).rows.map((r: Row) => r.__txSignature)).toEqual(["sig-a", "sig-b", "sig-c", "sig-d", "sig-e"]);

    const notified = await tableRouter.request(`/${TABLE_PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        txSignature: "sig-f",
        row: { value: "f" },
      }),
    });
    expect(notified.status).toBe(200);

    const cached = await tableRouter.request(`/${TABLE_PDA}/rows?limit=5`);
    const body = await cached.json();

    expect(body.cached).toBe(true);
    expect(body.count).toBe(5);
    expect(body.rows.map((r: Row) => r.__txSignature)).toEqual(["sig-f", "sig-a", "sig-b", "sig-c", "sig-d"]);
    expect(body.nextCursor).toBe("sig-d");
  });

  test("fresh rows fetch does not reuse a pending background-refresh promise", async () => {
    signatures = ["sig-a"];
    rowsBySig = new Map([
      ["sig-a", { __txSignature: "sig-a", value: "a" }],
      ["sig-fresh", { __txSignature: "sig-fresh", value: "fresh" }],
    ]);
    metaResponses.push(meta(1));

    const first = await tableRouter.request(`/${TABLE_PDA}/rows?limit=1`);
    expect(first.status).toBe(200);

    let releaseBackground!: (value: Meta) => void;
    const backgroundMeta = new Promise<Meta>((resolve) => {
      releaseBackground = resolve;
    });
    metaResponses.push(backgroundMeta, meta(2));

    const cached = await tableRouter.request(`/${TABLE_PDA}/rows?limit=1`);
    expect(cached.status).toBe(200);

    signatures = ["sig-fresh"];
    const fresh = await tableRouter.request(`/${TABLE_PDA}/rows?limit=1&fresh=true`);
    const body = await fresh.json();

    expect(fresh.status).toBe(200);
    expect(body.cached).toBe(false);
    expect(body.rows.map((r: Row) => r.__txSignature)).toEqual(["sig-fresh"]);

    releaseBackground(meta(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("background refresh stamps timestamp when the indexed newest sig is already cached", async () => {
    signatures = ["sig-a"];
    rowsBySig = new Map([
      ["sig-a", { __txSignature: "sig-a", value: "a" }],
    ]);
    metaResponses.push(meta(1));

    const first = await tableRouter.request(`/${TABLE_PDA}/rows?limit=3`);
    expect(first.status).toBe(200);

    signatureFetches = [];
    metaResponses.push(meta(2));

    const cached = await tableRouter.request(`/${TABLE_PDA}/rows?limit=3`);
    expect(cached.status).toBe(200);

    await waitFor(() => {
      const key = rowsCache.keys()[0];
      return !!key && rowsCache.get(key)?.lastTimestamp === 2;
    });
    expect(signatureFetches).toEqual([{ limit: 1000, before: undefined }]);
  });

  test("failed tx mid-history derives nextCursor from the signature scan", async () => {
    // gap-bad is a failed/undecodable tx: the scan returns its sig but it
    // decodes to no row. The page comes up one row short of `limit`, yet the
    // scan wasn't exhausted; the cursor must point at the last sig examined
    // so paging clients keep walking instead of treating the gap as the end.
    signatures = ["gap-1", "gap-2", "gap-bad", "gap-4", "gap-5", "gap-6"];
    rowsBySig = new Map(
      ["gap-1", "gap-2", "gap-4", "gap-5", "gap-6"].map((sig): [string, Row] => [sig, { __txSignature: sig, value: sig }]),
    );
    metaResponses.push(meta(1));

    const first = await tableRouter.request(`/${GAP_TABLE_PDA}/rows?limit=4`);
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.rows.map((r: Row) => r.__txSignature)).toEqual(["gap-1", "gap-2", "gap-4"]);
    expect(firstBody.count).toBe(3);
    expect(firstBody.nextCursor).toBe("gap-4");

    const second = await tableRouter.request(`/${GAP_TABLE_PDA}/rows?limit=4&before=${firstBody.nextCursor}`);
    const secondBody = await second.json();
    expect(secondBody.rows.map((r: Row) => r.__txSignature)).toEqual(["gap-5", "gap-6"]);
    // Short signature page: the scan really is exhausted this time.
    expect(secondBody.nextCursor).toBeNull();
  });

  test("notify on a short head page keeps the scan-derived cursor", async () => {
    // Two bad sigs leave the head page short of `limit` even after the
    // notify prepend. Nothing fell off the page, so the cursor from the
    // original scan must survive the rebuild instead of resetting to null.
    signatures = ["note-1", "note-bad-a", "note-bad-b", "note-4", "note-5"];
    rowsBySig = new Map(
      ["note-1", "note-4", "note-5"].map((sig): [string, Row] => [sig, { __txSignature: sig, value: sig }]),
    );
    metaResponses.push(meta(1));

    const first = await tableRouter.request(`/${GAP_TABLE_PDA}/rows?limit=5`);
    const firstBody = await first.json();
    expect(firstBody.count).toBe(3);
    expect(firstBody.nextCursor).toBe("note-5");

    const notified = await tableRouter.request(`/${GAP_TABLE_PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txSignature: "note-new", row: { value: "new" } }),
    });
    expect(notified.status).toBe(200);

    const cached = await tableRouter.request(`/${GAP_TABLE_PDA}/rows?limit=5`);
    const body = await cached.json();
    expect(body.cached).toBe(true);
    expect(body.rows.map((r: Row) => r.__txSignature)).toEqual(["note-new", "note-1", "note-4", "note-5"]);
    expect(body.nextCursor).toBe("note-5");
  });

  test("notify refill with a metadata-only bottom row falls back to its tx signature", async () => {
    // Metadata-only txs decode to { signature, metadata, data: null } with no
    // __txSignature (formatRow in chain/solana/reader.ts), and the sig-order
    // sort pins them to the page bottom. When a notify prepend refills the
    // page to `limit`, the rebuilt cursor must fall back to that row's
    // `signature` instead of overwriting the scan-derived cursor with null
    // and silently cutting off all older history.
    signatures = ["m-1", "m-2", "m-3", "m-4", "m-bad", "m-5", "m-6", "m-7", "m-meta", "m-8"];
    rowsBySig = new Map([
      ...["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7", "m-8"].map((sig): [string, Row] => [sig, { __txSignature: sig, value: sig }]),
      ["m-meta", { signature: "m-meta", metadata: "0", data: null } as unknown as Row] as [string, Row],
    ]);
    metaResponses.push(meta(1));

    const first = await tableRouter.request(`/${GAP_TABLE_PDA}/rows?limit=10`);
    const firstBody = await first.json();
    // Full signature page: 10 sigs scanned, m-bad decoded to nothing → 9 rows,
    // scan-derived cursor points at the last sig examined.
    expect(first.status).toBe(200);
    expect(firstBody.count).toBe(9);
    expect(firstBody.nextCursor).toBe("m-8");
    expect(firstBody.rows[firstBody.rows.length - 1].signature).toBe("m-meta");

    const notified = await tableRouter.request(`/${GAP_TABLE_PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txSignature: "m-new", row: { value: "new" } }),
    });
    expect(notified.status).toBe(200);

    const cached = await tableRouter.request(`/${GAP_TABLE_PDA}/rows?limit=10`);
    const body = await cached.json();
    expect(body.cached).toBe(true);
    expect(body.count).toBe(10);
    // The page refilled to limit with the metadata-only row at the bottom:
    // the cursor is its tx signature, never null on a full page.
    expect(body.rows[body.rows.length - 1].signature).toBe("m-meta");
    expect(body.nextCursor).toBe("m-meta");
  });

  test("background catch-up stops after the bounded page limit when overlap is missing", async () => {
    signatures = ["sig-old"];
    rowsBySig = new Map([
      ["sig-old", { __txSignature: "sig-old", value: "old" }],
    ]);
    metaResponses.push(meta(1));

    const first = await tableRouter.request(`/${TABLE_PDA}/rows?limit=4`);
    expect(first.status).toBe(200);

    const manyNew = Array.from({ length: 3500 }, (_, i) => `sig-new-${i}`);
    signatures = manyNew;
    rowsBySig = new Map([
      ...manyNew.slice(0, 4).map((sig): [string, Row] => [sig, { __txSignature: sig, value: sig }]),
      ["sig-old", { __txSignature: "sig-old", value: "old" }],
    ]);
    signatureFetches = [];
    metaResponses.push(meta(2));

    const cached = await tableRouter.request(`/${TABLE_PDA}/rows?limit=4`);
    expect(cached.status).toBe(200);

    await waitFor(() => signatureFetches.length === 3);

    const key = rowsCache.keys()[0];
    const entry = key ? rowsCache.get(key) : null;
    expect(signatureFetches).toEqual([
      { limit: 1000, before: undefined },
      { limit: 1000, before: "sig-new-999" },
      { limit: 1000, before: "sig-new-1999" },
    ]);
    expect(entry?.lastTimestamp).toBe(1);
    expect(entry?.rows?.map((r) => r.__txSignature)).toEqual(["sig-new-0", "sig-new-1", "sig-new-2", "sig-new-3"]);
  });
});

describe("/table/:pda/threads notify injection", () => {
  test("notify injects a new top-level note into the cached threads response", async () => {
    signatures = ["sig-note-a"];
    rowsBySig = new Map([
      ["sig-note-a", { __txSignature: "sig-note-a", id: "a", author: "alice", timestamp: 1, body: "first" }],
    ]);

    const first = await tableRouter.request(`/${TABLE_PDA}/threads`);
    expect(first.status).toBe(200);
    expect((await first.json()).threads.map((t: { op: Row }) => t.op.id)).toEqual(["a"]);

    const notified = await tableRouter.request(`/${TABLE_PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        txSignature: "sig-note-b",
        row: { id: "b", author: "bob", timestamp: 2, body: "second" },
      }),
    });
    expect(notified.status).toBe(200);

    const cached = await tableRouter.request(`/${TABLE_PDA}/threads`);
    const body = await cached.json();

    expect(body.cached).toBe(true);
    expect(body.count).toBe(2);
    expect(body.threads.map((t: { op: Row }) => t.op.id)).toEqual(["b", "a"]);
    expect(body.threads[0].totalReplies).toBe(0);
  });

  test("notify groups an injected reply under its parentId thread", async () => {
    signatures = ["sig-op-a"];
    rowsBySig = new Map([
      ["sig-op-a", { __txSignature: "sig-op-a", id: "a", author: "alice", timestamp: 1 }],
    ]);

    const first = await tableRouter.request(`/${TABLE_PDA}/threads?limit=50`);
    expect(first.status).toBe(200);

    const notified = await tableRouter.request(`/${TABLE_PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        txSignature: "sig-reply-b",
        row: { id: "b", author: "bob", timestamp: 2, meta: { parentId: "a" } },
      }),
    });
    expect(notified.status).toBe(200);

    const cached = await tableRouter.request(`/${TABLE_PDA}/threads?limit=50`);
    const body = await cached.json();

    expect(body.cached).toBe(true);
    expect(body.count).toBe(2);
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].op.id).toBe("a");
    expect(body.threads[0].totalReplies).toBe(1);
    expect(body.threads[0].replies.map((r: Row) => r.id)).toEqual(["b"]);
    expect(body.threads[0].replies[0].parentAuthor).toBe("alice");
  });

  test("row-less notify invalidates the cached threads response", async () => {
    signatures = ["sig-inv-a"];
    rowsBySig = new Map([
      ["sig-inv-a", { __txSignature: "sig-inv-a", id: "a", author: "alice", timestamp: 1 }],
    ]);

    const first = await tableRouter.request(`/${TABLE_PDA}/threads?limit=20`);
    expect(first.status).toBe(200);
    expect((await first.json()).cached).toBe(false);

    // Notify with no row payload and an unindexed sig → invalidation branch
    const notified = await tableRouter.request(`/${TABLE_PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txSignature: "sig-inv-missing" }),
    });
    expect((await notified.json()).cached).toBe(false);

    signatures = ["sig-inv-b", "sig-inv-a"];
    rowsBySig.set("sig-inv-b", { __txSignature: "sig-inv-b", id: "b", author: "bob", timestamp: 2 });

    const fresh = await tableRouter.request(`/${TABLE_PDA}/threads?limit=20`);
    const body = await fresh.json();

    expect(body.cached).toBe(false);
    expect(body.threads.map((t: { op: Row }) => t.op.id)).toEqual(["b", "a"]);
  });

  test("in-flight background refresh keeps a concurrently notify-injected row", async () => {
    signatures = ["sig-race-a"];
    rowsBySig = new Map([
      ["sig-race-a", { __txSignature: "sig-race-a", id: "a", author: "alice", timestamp: 1 }],
    ]);

    // Cold fetch populates the cache with [a].
    const cold = await tableRouter.request(`/${TABLE_PDA}/threads?limit=50`);
    expect(cold.status).toBe(200);

    // Gate the RPC, then hit the cached entry: shouldRefresh passes and
    // launches a background fetchThreads that blocks on the gate,
    // simulating an in-flight refresh started before the notify below.
    let release!: () => void;
    signatureGate = new Promise<void>((resolve) => { release = resolve; });
    const warm = await tableRouter.request(`/${TABLE_PDA}/threads?limit=50`);
    expect((await warm.json()).cached).toBe(true);

    // /notify lands while that refresh is in flight and injects row b.
    const notified = await tableRouter.request(`/${TABLE_PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        txSignature: "sig-race-b",
        row: { id: "b", author: "bob", timestamp: 2 },
      }),
    });
    expect(notified.status).toBe(200);

    const afterNotify = await tableRouter.request(`/${TABLE_PDA}/threads?limit=50`);
    expect((await afterNotify.json()).threads.map((t: { op: Row }) => t.op.id)).toEqual(["b", "a"]);

    // The in-flight refresh resolves with the RPC-lagged signature list
    // (still only sig-race-a). It must merge, not wholesale-replace, so
    // the injected row survives; notify's lastRefresh stamp would otherwise
    // block the corrective refresh for 30s while the entry serves stale.
    release();
    signatureGate = null;
    await waitFor(() => inflight.size === 0);

    const afterRefresh = await tableRouter.request(`/${TABLE_PDA}/threads?limit=50`);
    const body = await afterRefresh.json();
    expect(body.threads.map((t: { op: Row }) => t.op.id)).toEqual(["b", "a"]);
    expect(body.count).toBe(2);
  });
});
