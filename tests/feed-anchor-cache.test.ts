import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Keypair } from "@solana/web3.js";

import "./helpers/cache-fixture";

// Feed anchors are rent-free signature anchors: getSignaturesForAddress works
// on them but there is no Table account, so getTableMetaCached returns null.
// These tests pin the cache paths that used to strand such tables on stale
// pages (live incident: the blockchan /iq feed served a May head page while
// the chain, and small uncached limits, had newer posts).
//
// Every test generates a fresh PDA: the route's refresh-throttle map and the
// disk cache are module-level state shared across tests, files, and
// --rerun-each executions, so a fixed PDA would leak pages between runs.

type Row = Record<string, unknown> & { __txSignature: string };

let signatures: string[] = [];
let rowsBySig = new Map<string, Row>();
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
  readTableMeta: async () => null,
  getTableMetaCached: async () => null,
}));

const { tableRouter, rowsCache, indexCache, sliceCache, inflight } = await import("../src/routes/table");
const { getDiskCache } = await import("../src/cache");
const { createHash } = await import("node:crypto");

// Mirror of the route's internal cacheKey(): head-page key for a limit.
function headKey(tablePda: string, limit: number): string {
  return createHash("sha256").update([tablePda, String(limit), ""].join(":")).digest("hex").slice(0, 24);
}

function freshPda(): string {
  return Keypair.generate().publicKey.toBase58();
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

async function waitForDiskSig(pda: string, limit: number, sig: string): Promise<string> {
  let json = "";
  for (let i = 0; i < 60 && !json.includes(sig); i++) {
    json = (await getDiskCache("rows", headKey(pda, limit)))?.toString("utf8") ?? "";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(json).toContain(sig);
  return json;
}

beforeEach(() => {
  signatures = [];
  rowsBySig = new Map();
  signatureFetches = [];
  rowsCache.clear();
  indexCache.clear();
  sliceCache.clear();
  inflight.clear();
});

describe("feed anchor (no Table account) cache refresh", () => {
  test("background refresh still catches up when table meta is null", async () => {
    const PDA = freshPda();
    signatures = ["sig-a"];
    rowsBySig = new Map([["sig-a", { __txSignature: "sig-a", value: "a" }]]);

    const first = await tableRouter.request(`/${PDA}/rows?limit=3`);
    expect(first.status).toBe(200);
    expect((await first.json()).rows.map((r: Row) => r.__txSignature)).toEqual(["sig-a"]);

    // An external writer lands a new row that never hits /notify.
    signatures = ["sig-new", "sig-a"];
    rowsBySig.set("sig-new", { __txSignature: "sig-new", value: "new" });
    signatureFetches = [];

    // Head-page hit triggers the background refresh. With meta null it must
    // fall through to the signature overlap scan instead of bailing.
    const cached = await tableRouter.request(`/${PDA}/rows?limit=3`);
    expect(cached.status).toBe(200);

    await waitFor(() => {
      const rows = rowsCache.get(headKey(PDA, 3))?.rows;
      return rows?.[0]?.__txSignature === "sig-new";
    });
    expect(signatureFetches.length).toBeGreaterThan(0);
  });

  test("notify writes the verified prepended head page through to disk", async () => {
    const PDA = freshPda();
    signatures = ["sig-a"];
    rowsBySig = new Map([["sig-a", { __txSignature: "sig-a", value: "a" }]]);

    const first = await tableRouter.request(`/${PDA}/rows?limit=5`);
    expect(first.status).toBe(200);

    // The tx is real: readSingleRow can resolve it, so the write-through
    // verification passes and the page lands on disk.
    rowsBySig.set("sig-b", { __txSignature: "sig-b", value: "b" });
    const notified = await tableRouter.request(`/${PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txSignature: "sig-b", row: { value: "b" } }),
    });
    expect(notified.status).toBe(200);

    // Write-through is async (verify then persist); wait for it to land.
    await waitForDiskSig(PDA, 5, "sig-b");

    // Simulate a restart: memory gone, next read promotes the disk copy.
    rowsCache.clear();
    const promoted = await tableRouter.request(`/${PDA}/rows?limit=5`);
    const body = await promoted.json();
    expect(body.cached).toBe(true);
    expect(body.rows.map((r: Row) => r.__txSignature)).toEqual(["sig-b", "sig-a"]);
  });

  test("notify with no memory entry prepends into the promoted disk page", async () => {
    const PDA = freshPda();
    signatures = ["sig-a"];
    rowsBySig = new Map([["sig-a", { __txSignature: "sig-a", value: "a" }]]);

    const first = await tableRouter.request(`/${PDA}/rows?limit=5`);
    expect(first.status).toBe(200);
    // Precondition: the cold fetch's page actually landed on disk, so the
    // notify below exercises the disk-promote path, not a cold fetch.
    await waitForDiskSig(PDA, 5, "sig-a");

    // Restart before the post: /notify finds no memory entry. It must
    // promote the disk page and prepend into it, so earlier rows survive
    // even while the RPC has indexed neither (the lag /notify exists for).
    rowsCache.clear();
    rowsBySig.set("sig-b", { __txSignature: "sig-b", value: "b" });
    const notified = await tableRouter.request(`/${PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txSignature: "sig-b", row: { value: "b" } }),
    });
    expect(notified.status).toBe(200);

    const after = await tableRouter.request(`/${PDA}/rows?limit=5`);
    const body = await after.json();
    expect(body.rows.map((r: Row) => r.__txSignature)).toEqual(["sig-b", "sig-a"]);

    // And the merged page survives another restart once written through.
    await waitForDiskSig(PDA, 5, "sig-b");
    rowsCache.clear();
    const promoted = await tableRouter.request(`/${PDA}/rows?limit=5`);
    const promotedBody = await promoted.json();
    expect(promotedBody.rows.map((r: Row) => r.__txSignature)).toEqual(["sig-b", "sig-a"]);
  });

  test("unverifiable notify row stays memory-only and never poisons disk", async () => {
    const PDA = freshPda();
    signatures = ["sig-a"];
    rowsBySig = new Map([["sig-a", { __txSignature: "sig-a", value: "a" }]]);

    const first = await tableRouter.request(`/${PDA}/rows?limit=5`);
    expect(first.status).toBe(200);
    await waitForDiskSig(PDA, 5, "sig-a");

    // Fabricated signature: readSingleRow cannot resolve it, so the
    // write-through verification must refuse to persist the page.
    const notified = await tableRouter.request(`/${PDA}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txSignature: "sig-fake", row: { value: "spoof" } }),
    });
    expect(notified.status).toBe(200);

    // Memory serves it (indexing-lag UX, dies with HEAD_TTL, same as ever).
    const hot = await tableRouter.request(`/${PDA}/rows?limit=5`);
    expect((await hot.json()).rows.map((r: Row) => r.__txSignature)).toEqual(["sig-fake", "sig-a"]);

    // Disk never gets it: after the verification window, the page on disk
    // still carries only the chain-backed row, and a restart drops the fake.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const disk = (await getDiskCache("rows", headKey(PDA, 5)))?.toString("utf8") ?? "";
    expect(disk).toContain("sig-a");
    expect(disk).not.toContain("sig-fake");

    rowsCache.clear();
    const promoted = await tableRouter.request(`/${PDA}/rows?limit=5`);
    expect((await promoted.json()).rows.map((r: Row) => r.__txSignature)).toEqual(["sig-a"]);
  });
});
