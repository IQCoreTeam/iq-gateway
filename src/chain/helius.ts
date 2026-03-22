// Helius RPC helpers — uses gTFA (getTransactionsForAddress) for fast bulk reads.
// Requires a paid Helius plan. Gracefully disabled when no API key is set.

import type { VersionedTransactionResponse } from "@solana/web3.js";

const cluster = process.env.SOLANA_CLUSTER || "devnet";

const HELIUS_RPC_BASE =
  cluster === "mainnet-beta"
    ? "https://mainnet.helius-rpc.com"
    : cluster === "devnet"
      ? "https://devnet.helius-rpc.com"
      : null;

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

export const HELIUS_RPC = HELIUS_API_KEY && HELIUS_RPC_BASE
  ? `${HELIUS_RPC_BASE}/?api-key=${HELIUS_API_KEY}`
  : null;

export function isHeliusEnabled(): boolean {
  return HELIUS_RPC !== null;
}

// ─── JSON-RPC helper ───────────────────────────────────────────────────────

async function rpc(body: object): Promise<any> {
  if (!HELIUS_RPC) throw new Error("Helius not configured");
  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Helius RPC error: HTTP ${res.status}`);
  return res.json();
}

// ─── gTFA: getTransactionsForAddress ───────────────────────────────────────
// Returns up to 100 full transactions per call with cursor-based pagination.
// Combines getSignaturesForAddress + getTransaction into one fast call.
// Paid plans only.

export async function heliusGetTransactionsForAddress(
  address: string,
  maxTxs = 10000,
): Promise<VersionedTransactionResponse[]> {
  const all: VersionedTransactionResponse[] = [];
  let paginationToken: string | undefined;

  while (all.length < maxTxs) {
    const json = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransactionsForAddress",
      params: [address, {
        limit: 100,
        transactionDetails: "full",
        ...(paginationToken ? { paginationToken } : {}),
      }],
    });

    const result = json.result;
    if (!result) break;

    const txs: VersionedTransactionResponse[] = result.data ?? [];
    if (txs.length === 0) break;

    all.push(...txs);
    paginationToken = result.paginationToken;
    if (!paginationToken || txs.length < 100) break;
  }

  return all;
}

// ─── Batch transaction fetching (for table row reads) ──────────────────────

export async function heliusBatchGetTransactions(
  signatures: string[],
): Promise<Map<string, VersionedTransactionResponse | null>> {
  const results = new Map<string, VersionedTransactionResponse | null>();
  if (signatures.length === 0) return results;

  const batch = signatures.map((sig, i) => ({
    jsonrpc: "2.0" as const,
    id: i,
    method: "getTransaction",
    params: [sig, { maxSupportedTransactionVersion: 0, encoding: "json" }],
  }));

  const responses = await rpc(batch) as Array<{ id: number; result?: VersionedTransactionResponse | null; error?: unknown }>;

  for (const resp of responses) {
    const sig = signatures[resp.id];
    results.set(sig, resp.result ?? null);
  }

  return results;
}

// ─── Signature fetching (fallback for non-gTFA uses) ───────────────────────

export async function heliusGetSignatures(
  address: string,
  limit = 50,
  before?: string,
): Promise<string[]> {
  const json = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "getSignaturesForAddress",
    params: [address, { limit, ...(before && { before }) }],
  });
  return (json.result || []).map((s: { signature: string }) => s.signature);
}

export async function heliusGetAllSignatures(
  address: string,
  maxSigs = 10000,
): Promise<string[]> {
  const allSigs: string[] = [];
  let before: string | undefined;

  while (allSigs.length < maxSigs) {
    const limit = Math.min(1000, maxSigs - allSigs.length);
    const page = await heliusGetSignatures(address, limit, before);
    if (page.length === 0) break;

    allSigs.push(...page);
    before = page[page.length - 1];
    if (page.length < limit) break;
  }

  return allSigs;
}
