import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import iqlabs from "@iqlabs-official/solana-sdk";
import { reader } from "@iqlabs-official/solana-sdk";
import { createHash } from "node:crypto";
import {
  isHeliusEnabled,
  HELIUS_RPC,
  heliusGetAllSignatures,
  heliusGetSignatures,
  heliusBatchGetTransactions,
} from "./helius";

const PRIMARY_RPC = HELIUS_RPC || process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const FALLBACK_RPC = process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

iqlabs.setRpcUrl(PRIMARY_RPC);
let activeRpc = PRIMARY_RPC;
let solConnection = new Connection(PRIMARY_RPC);

if (isHeliusEnabled()) {
  console.log("[reader] Helius RPC enabled — using batch transactions + enhanced endpoints");
}

// ─── Global RPC rate limiter ─────────────────────────────────────────────────

const defaultMaxTokens = isHeliusEnabled() ? 100 : 30;
const defaultRefillRate = isHeliusEnabled() ? 50 : 10;

const RATE_LIMIT = {
  maxTokens: Number(process.env.RPC_RATE_LIMIT) || defaultMaxTokens,
  refillRate: Number(process.env.RPC_REFILL_RATE) || defaultRefillRate,
  tokens: Number(process.env.RPC_RATE_LIMIT) || defaultMaxTokens,
  lastRefill: Date.now(),
};

function acquireToken(): boolean {
  const now = Date.now();
  const elapsed = (now - RATE_LIMIT.lastRefill) / 1000;
  RATE_LIMIT.tokens = Math.min(RATE_LIMIT.maxTokens, RATE_LIMIT.tokens + elapsed * RATE_LIMIT.refillRate);
  RATE_LIMIT.lastRefill = now;

  if (RATE_LIMIT.tokens < 1) return false;
  RATE_LIMIT.tokens -= 1;
  return true;
}

async function waitForToken(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!acquireToken()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("RPC rate limit exceeded — try again later");
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

// ─── RPC metrics ─────────────────────────────────────────────────────────────

const metrics = {
  totalCalls: 0,
  rateLimited: 0,
  errors: 0,
  fallbacks: 0,
  heliusCalls: 0,
};

export function getRpcMetrics() {
  return {
    ...metrics,
    heliusEnabled: isHeliusEnabled(),
    availableTokens: Math.floor(RATE_LIMIT.tokens),
    maxTokens: RATE_LIMIT.maxTokens,
    refillRate: RATE_LIMIT.refillRate,
  };
}

// ─── Retry with rate limiting ────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  await waitForToken();
  metrics.totalCalls++;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);

      // 429 rate limited by RPC provider — back off exponentially
      if (msg.includes("429") && i < maxRetries) {
        metrics.rateLimited++;
        const delay = 1000 * 2 ** i;
        console.warn(`[reader] 429 rate-limited, retry ${i + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Connection errors — try fallback RPC once
      if (i === 0 && (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("503") || msg.includes("max usage reached"))) {
        metrics.fallbacks++;
        console.warn(`[reader] Primary RPC failed (${msg}), trying fallback`);
        iqlabs.setRpcUrl(FALLBACK_RPC);
        activeRpc = FALLBACK_RPC;
        solConnection = new Connection(FALLBACK_RPC);
        try {
          return await fn();
        } finally {
          iqlabs.setRpcUrl(PRIMARY_RPC);
          activeRpc = PRIMARY_RPC;
          solConnection = new Connection(PRIMARY_RPC);
        }
      }

      metrics.errors++;
      throw e;
    }
  }
  throw new Error("unreachable");
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function generateETag(content: string | Buffer): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
}

export function decodeAssetData(data: string): Buffer {
  if (data.startsWith("data:")) {
    return Buffer.from(data.split(",")[1], "base64");
  }
  if (/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 100)) && data.length > 100) {
    return Buffer.from(data, "base64");
  }
  return Buffer.from(data);
}

export function detectImageType(buf: Buffer): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf.length > 10 && buf[8] === 0x57 && buf[9] === 0x45) return "image/webp";
  return null;
}

export async function readAsset(txSig: string) {
  return withRetry(() => iqlabs.reader.readCodeIn(txSig));
}

export async function listUserAssets(userPubkey: string, limit = 20, before?: string) {
  return withRetry(() => iqlabs.reader.fetchInventoryTransactions(new PublicKey(userPubkey), limit, before));
}

export async function listUserSessions(userPubkey: string) {
  return withRetry(() => iqlabs.reader.getSessionPdaList(userPubkey));
}

export async function readUserState(userPubkey: string) {
  return withRetry(() => iqlabs.reader.readUserState(userPubkey));
}

// 'medium' speed balances latency vs RPC call count — 'fast' hammers the RPC, 'slow' is too laggy for UI
export async function fetchUserConnections(userPubkey: string) {
  return withRetry(() => iqlabs.reader.fetchUserConnections(userPubkey, { speed: 'medium' }));
}

// Fetches recent signatures for a table PDA. Tries Helius first if available.
export async function fetchRecentSignatures(
  tablePda: string,
  limit = 50,
  before?: string,
): Promise<string[]> {
  if (isHeliusEnabled()) {
    metrics.heliusCalls++;
    metrics.totalCalls++;
    try {
      return await heliusGetSignatures(tablePda, limit, before);
    } catch (e) {
      console.warn("[reader] Helius sig fetch failed, falling back:", e instanceof Error ? e.message : e);
    }
  }

  return withRetry(async () => {
    const pk = new PublicKey(tablePda);
    const opts: { limit: number; before?: string } = { limit };
    if (before) opts.before = before;
    const sigs = await solConnection.getSignaturesForAddress(pk, opts);
    return sigs.map((s: { signature: string }) => s.signature);
  });
}

// Convert {data, metadata} from readCodeIn into a row object with __txSignature.
function formatRow(sig: string, data: string | null, metadata: string): Record<string, unknown> {
  if (!data) return { signature: sig, metadata, data: null };
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...parsed, __txSignature: sig };
    }
  } catch {}
  return { signature: sig, metadata, data };
}

// Read a single row by transaction signature. Returns null for non-row txs.
export async function readSingleRow(sig: string): Promise<Record<string, unknown> | null> {
  return withRetry(async () => {
    try {
      const { data, metadata } = await iqlabs.reader.readCodeIn(sig);
      return formatRow(sig, data, metadata);
    } catch (err) {
      if (err instanceof Error && err.message.includes("instruction not found")) {
        return null;
      }
      throw err;
    }
  });
}

// Parse a pre-fetched transaction into a row. Skips the getTransaction RPC call.
async function parseTransactionToRow(
  sig: string,
  tx: VersionedTransactionResponse,
): Promise<Record<string, unknown> | null> {
  try {
    const { data, metadata } = await reader.readUserInventoryCodeInFromTx(tx);
    return formatRow(sig, data, metadata);
  } catch (err) {
    if (err instanceof Error && err.message.includes("instruction not found")) {
      return null;
    }
    throw err;
  }
}

// Fetch the full signature index for a table PDA. Tries Helius first if available.
export async function fetchSignatureIndex(
  tablePda: string,
  maxSignatures = 10000,
): Promise<string[]> {
  if (isHeliusEnabled()) {
    metrics.heliusCalls++;
    metrics.totalCalls++;
    try {
      return await heliusGetAllSignatures(tablePda, maxSignatures);
    } catch (e) {
      console.warn("[reader] Helius index fetch failed, falling back:", e instanceof Error ? e.message : e);
    }
  }

  return withRetry(() => iqlabs.reader.collectSignatures(tablePda, maxSignatures));
}

export async function readRowsBySignatures(
  signatures: string[],
  tablePda?: string,
): Promise<Array<Record<string, unknown>>> {
  return withRetry(() => iqlabs.reader.readTableRows(tablePda ?? signatures[0], { signatures }));
}

// Fetch and parse multiple rows in parallel.
// Tries Helius JSON-RPC batching first (single HTTP POST, requires paid plan).
// Falls back to parallel readSingleRow with concurrency scaled by RPC capacity.
export async function readMultipleRows(
  signatures: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const results = new Map<string, Record<string, unknown> | null>();
  if (signatures.length === 0) return results;

  // Try batch fetch (single HTTP call for all transactions)
  if (isHeliusEnabled()) {
    metrics.heliusCalls++;
    metrics.totalCalls++;
    try {
      const txMap = await heliusBatchGetTransactions(signatures);
      const settled = await Promise.allSettled(
        signatures.map(async (sig) => {
          const tx = txMap.get(sig);
          if (!tx) return { sig, row: null as Record<string, unknown> | null };
          const row = await parseTransactionToRow(sig, tx);
          return { sig, row };
        }),
      );
      for (const r of settled) {
        if (r.status === "fulfilled") results.set(r.value.sig, r.value.row);
      }
      return results;
    } catch {
      // Batch not available (free plan) — fall through to parallel individual fetches
    }
  }

  const CONCURRENCY = isHeliusEnabled() ? 20 : 5;
  for (let i = 0; i < signatures.length; i += CONCURRENCY) {
    const chunk = signatures.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (sig) => ({ sig, row: await readSingleRow(sig) })),
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === "fulfilled") {
        results.set(r.value.sig, r.value.row);
      } else {
        results.set(chunk[j], null);
      }
    }
  }

  return results;
}
