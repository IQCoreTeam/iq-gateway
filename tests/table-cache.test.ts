import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.CACHE_DIR = `/tmp/iq-gateway-table-cache-test-${process.pid}`;

const TABLE_PDA = "11111111111111111111111111111111";

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
  metaResponses = [];
  signatureFetches = [];
  rowsCache.clear();
  indexCache.clear();
  sliceCache.clear();
  inflight.clear();
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
