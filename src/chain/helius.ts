/**
 * Helius-specific RPC helpers.
 *
 * When HELIUS_API_KEY is set, these functions use Helius's faster infrastructure
 * for signature scanning and batch transaction fetching.
 *
 * Key advantages over standard RPC:
 *  - Higher rate limits (100+ req/s vs 10 req/s)
 *  - Faster `getSignaturesForAddress` indexing
 *  - JSON-RPC batching for parallel transaction fetches
 *  - Enhanced transaction parsing for known programs
 */

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const cluster = process.env.SOLANA_CLUSTER || "devnet";

const HELIUS_RPC_BASE =
  cluster === "mainnet-beta"
    ? "https://mainnet.helius-rpc.com"
    : cluster === "devnet"
      ? "https://devnet.helius-rpc.com"
      : null;

const HELIUS_RPC = HELIUS_API_KEY && HELIUS_RPC_BASE
  ? `${HELIUS_RPC_BASE}/?api-key=${HELIUS_API_KEY}`
  : null;

const HELIUS_API_BASE =
  cluster === "mainnet-beta"
    ? "https://api.helius.xyz"
    : cluster === "devnet"
      ? "https://api-devnet.helius.xyz"
      : null;

export function isHeliusEnabled(): boolean {
  return HELIUS_RPC !== null;
}

export function getHeliusRpcUrl(): string | null {
  return HELIUS_RPC;
}

// ─── Paginated signature collection ──────────────────────────────────────────
// Helius handles getSignaturesForAddress significantly faster than public RPCs.
// This bypasses the SDK's collectSignatures and goes directly to Helius.

export async function heliusGetAllSignatures(
  address: string,
  maxSigs = 10000,
): Promise<string[]> {
  if (!HELIUS_RPC) throw new Error("Helius not configured");

  const allSigs: string[] = [];
  let before: string | undefined;

  while (allSigs.length < maxSigs) {
    const limit = Math.min(1000, maxSigs - allSigs.length);
    const params: [string, { limit: number; before?: string }] = [
      address,
      { limit },
    ];
    if (before) params[1].before = before;

    const res = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params,
      }),
    });

    if (!res.ok) throw new Error(`Helius RPC error: HTTP ${res.status}`);
    const json = await res.json() as { result?: { signature: string }[] };
    const result = json.result;
    if (!result || result.length === 0) break;

    for (const s of result) allSigs.push(s.signature);
    before = result[result.length - 1].signature;
    if (result.length < limit) break;
  }

  return allSigs;
}

// ─── Batch getTransaction ────────────────────────────────────────────────────
// Fetch multiple transactions in a single HTTP request using JSON-RPC batching.
// Helius supports batch sizes up to 100. For larger sets, we chunk.

interface BatchTxResult {
  signature: string;
  transaction: unknown;
  error?: string;
}

const BATCH_SIZE = 100;

export async function heliusBatchGetTransactions(
  signatures: string[],
): Promise<BatchTxResult[]> {
  if (!HELIUS_RPC) throw new Error("Helius not configured");

  const results: BatchTxResult[] = [];

  // Process in chunks of BATCH_SIZE
  for (let i = 0; i < signatures.length; i += BATCH_SIZE) {
    const chunk = signatures.slice(i, i + BATCH_SIZE);

    const batch = chunk.map((sig, idx) => ({
      jsonrpc: "2.0" as const,
      id: idx,
      method: "getTransaction",
      params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    }));

    const res = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });

    if (!res.ok) throw new Error(`Helius batch RPC error: HTTP ${res.status}`);
    const batchResult = await res.json() as Array<{ id: number; result?: unknown; error?: { message: string } }>;

    // Sort by id to maintain order
    batchResult.sort((a, b) => a.id - b.id);

    for (let j = 0; j < chunk.length; j++) {
      const entry = batchResult[j];
      results.push({
        signature: chunk[j],
        transaction: entry?.result ?? null,
        error: entry?.error?.message,
      });
    }
  }

  return results;
}

// ─── Enhanced Transaction History (Helius-specific API) ──────────────────────
// Returns enriched/parsed transaction data. Works best for known programs
// (SPL Token, System, Metaplex). For custom programs like IQLabs, it returns
// raw instruction data which still needs SDK-level parsing.

export async function heliusGetTransactionHistory(
  address: string,
  options: { before?: string; limit?: number; type?: string } = {},
): Promise<unknown[]> {
  if (!HELIUS_API_BASE || !HELIUS_API_KEY) throw new Error("Helius not configured");

  const params = new URLSearchParams();
  params.set("api-key", HELIUS_API_KEY);

  const url = `${HELIUS_API_BASE}/v0/addresses/${address}/transactions?${params}`;

  const body: Record<string, unknown> = {};
  if (options.before) body.before = options.before;
  if (options.limit) body.limit = options.limit;
  if (options.type) body.type = options.type;

  const res = await fetch(url, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) throw new Error(`Helius API error: HTTP ${res.status}`);
  return await res.json() as unknown[];
}

// ─── Paginated getSignaturesForAddress (single page) ─────────────────────────
// Thin wrapper used by reader.ts for the rows endpoint's Phase 1 sig scan.

export async function heliusGetSignatures(
  address: string,
  limit = 50,
  before?: string,
): Promise<string[]> {
  if (!HELIUS_RPC) throw new Error("Helius not configured");

  const params: [string, { limit: number; before?: string }] = [
    address,
    { limit },
  ];
  if (before) params[1].before = before;

  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params,
    }),
  });

  if (!res.ok) throw new Error(`Helius RPC error: HTTP ${res.status}`);
  const json = await res.json() as { result?: { signature: string }[] };
  return (json.result || []).map(s => s.signature);
}
