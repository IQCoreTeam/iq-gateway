import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.CACHE_DIR = `/tmp/iq-gateway-table-threads-test-${process.pid}`;

const TABLE_PDA = "11111111111111111111111111111111";

// Sig names are prefixed "tsig-" so the per-row disk cache (keyed by sig,
// shared across the whole test process) never collides with other test files.
type Row = Record<string, unknown> & { __txSignature: string };

let signatures: string[] = [];
let rowsBySig = new Map<string, Row>();
let signatureError: Error | null = null;
let signatureFetches: Array<{ limit: number; before?: string }> = [];

mock.module("../src/chain/solana", () => ({
  readAsset: async () => null,
  listUserAssets: async () => [],
  listUserSessions: async () => [],
  readUserState: async () => null,
  fetchUserConnections: async () => [],
  fetchSignatureIndex: async () => [],
  readRowsBySignatures: async (sigs: string[]) => sigs.map((sig) => rowsBySig.get(sig)).filter(Boolean),
  fetchRecentSignatures: async (_tablePda: string, limit = 50, before?: string) => {
    if (signatureError) throw signatureError;
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
  readTableMeta: async () => ({ name: "test", columns: [], idCol: "id", lastTimestamp: 1, gate: null }),
  getTableMetaCached: async () => ({ name: "test", columns: [], idCol: "id", lastTimestamp: 1, gate: null }),
}));

const { tableRouter, rowsCache, indexCache, sliceCache, inflight } = await import("../src/routes/table");

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
  signatureError = null;
  signatureFetches = [];
  rowsCache.clear();
  indexCache.clear();
  sliceCache.clear();
  inflight.clear();
});

describe("/table/:pda/threads", () => {
  test("groups a flat comment table into threads with parentAuthor refs", async () => {
    // Newest-first, mirroring the signature scan. Replies reference their
    // parent via meta.parentId (object form on tsig-b, string form on tsig-d)
    // (both arrive from chain), grandchild d flattens under top-level a.
    signatures = ["tsig-c", "tsig-d", "tsig-b", "tsig-a"];
    rowsBySig = new Map<string, Row>([
      ["tsig-c", { __txSignature: "tsig-c", id: "c", author: "carol", timestamp: 3 }],
      ["tsig-d", { __txSignature: "tsig-d", id: "d", author: "dave", timestamp: 4, meta: '{"parentId":"b"}' }],
      ["tsig-b", { __txSignature: "tsig-b", id: "b", author: "bob", timestamp: 2, meta: { parentId: "a" } }],
      ["tsig-a", { __txSignature: "tsig-a", id: "a", author: "alice", timestamp: 1 }],
    ]);

    const res = await tableRouter.request(`/${TABLE_PDA}/threads`);
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toStartWith('W/"');
    const body = await res.json();

    expect(body.cached).toBe(false);
    expect(body.tablePda).toBe(TABLE_PDA);
    expect(body.count).toBe(4);
    expect(signatureFetches).toEqual([{ limit: 100, before: undefined }]); // default scan limit

    expect(body.threads.map((t: { op: Row }) => t.op.id)).toEqual(["c", "a"]);
    const [lone, threaded] = body.threads;
    expect(lone.totalReplies).toBe(0);
    // Replies sort oldest-first; the grandchild keeps its DIRECT parent's author.
    expect(threaded.totalReplies).toBe(2);
    expect(threaded.replies.map((r: Row) => [r.id, r.parentAuthor])).toEqual([
      ["b", "alice"],
      ["d", "bob"],
    ]);
  });

  test("unknown table is an empty section, invalid PDA is 400, RPC failure is 500", async () => {
    // Valid PDA with no history → empty threads, NOT a 404 (a table "exists"
    // the moment someone writes to it; before that it's just empty).
    const empty = await tableRouter.request(`/${TABLE_PDA}/threads?limit=9999`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ tablePda: TABLE_PDA, threads: [], count: 0 });
    expect(signatureFetches).toEqual([{ limit: 500, before: undefined }]); // limit caps at 500

    const invalid = await tableRouter.request("/not-a-pda/threads");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid table PDA" });

    signatureError = new Error("rpc down");
    const failed = await tableRouter.request(`/${TABLE_PDA}/threads?limit=3`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "failed to read threads" });
  });

  test("second hit serves from memory with a stable ETag and honors If-None-Match", async () => {
    signatures = ["tsig-e1"];
    rowsBySig = new Map<string, Row>([["tsig-e1", { __txSignature: "tsig-e1", id: "e1", timestamp: 1 }]]);

    const first = await tableRouter.request(`/${TABLE_PDA}/threads?limit=7`);
    expect(first.status).toBe(200);
    expect((await first.json()).cached).toBe(false);
    const etag = first.headers.get("ETag");

    // ETag derives from the cached JSON, not the `cached` envelope flag, so a
    // client that fetched cold revalidates against the warm cache.
    const conditional = await tableRouter.request(`/${TABLE_PDA}/threads?limit=7`, {
      headers: { "if-none-match": etag! },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("ETag")).toBe(etag);

    // The mem hit kicked off a background refresh; let it settle.
    await waitFor(() => signatureFetches.length === 2);
  });

  test("stale-while-revalidate: mem hit serves old data, background refresh updates it", async () => {
    signatures = ["tsig-f1"];
    rowsBySig = new Map<string, Row>([
      ["tsig-f1", { __txSignature: "tsig-f1", id: "f1", timestamp: 1 }],
      ["tsig-f2", { __txSignature: "tsig-f2", id: "f2", timestamp: 2 }],
    ]);

    const first = await tableRouter.request(`/${TABLE_PDA}/threads?limit=9`);
    expect((await first.json()).count).toBe(1);

    signatures = ["tsig-f2", "tsig-f1"]; // a new row lands on chain

    const stale = await tableRouter.request(`/${TABLE_PDA}/threads?limit=9`);
    const staleBody = await stale.json();
    expect(staleBody.cached).toBe(true);
    expect(staleBody.count).toBe(1); // still the cached page
    expect(stale.headers.get("ETag")).toBe(first.headers.get("ETag"));

    await waitFor(() => {
      const key = rowsCache.keys()[0];
      return !!key && JSON.parse(rowsCache.get(key)!.json).count === 2;
    });

    const refreshed = await tableRouter.request(`/${TABLE_PDA}/threads?limit=9`);
    const refreshedBody = await refreshed.json();
    expect(refreshedBody.cached).toBe(true);
    expect(refreshedBody.count).toBe(2);
    expect(refreshedBody.threads.map((t: { op: Row }) => t.op.id)).toEqual(["f2", "f1"]);
    // Refresh throttle: the third request is within the 30s window → no refetch.
    expect(signatureFetches).toEqual([
      { limit: 9, before: undefined },
      { limit: 9, before: undefined },
    ]);
  });
});
