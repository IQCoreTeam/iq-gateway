import { Connection, PublicKey } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { createHash } from "node:crypto";

const PRIMARY_RPC = process.env.SOLANA_RPC_ENDPOINT || "https://mainnet.helius-rpc.com/?api-key=a0b8ead5-9dc8-4926-b537-9a4b32439f2f";
const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

iqlabs.setRpcUrl(PRIMARY_RPC);
const solConnection = new Connection(PRIMARY_RPC);

// ─── Global RPC rate limiter ─────────────────────────────────────────────────
// Token bucket: limits total RPC calls across all endpoints.
// Prevents hammering the RPC even if many different cache keys miss at once.

const RATE_LIMIT = {
  maxTokens: Number(process.env.RPC_RATE_LIMIT) || 30, // max burst
  refillRate: Number(process.env.RPC_REFILL_RATE) || 10, // tokens per second
  tokens: Number(process.env.RPC_RATE_LIMIT) || 30,
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
};

export function getRpcMetrics() {
  return {
    ...metrics,
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
      if (i === 0 && (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("503"))) {
        metrics.fallbacks++;
        console.warn(`[reader] Primary RPC failed (${msg}), trying fallback`);
        iqlabs.setRpcUrl(FALLBACK_RPC);
        try {
          return await fn();
        } catch {
          iqlabs.setRpcUrl(PRIMARY_RPC);
          throw e;
        } finally {
          iqlabs.setRpcUrl(PRIMARY_RPC);
        }
      }

      metrics.errors++;
      throw e;
    }
  }
  throw new Error("unreachable");
}

// ─── Public API ──────────────────────────────────────────────────────────────

type TableRowOptions = {
  limit?: number;
  before?: string;
  speed?: string;
};

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

export async function readTableRows(
  tablePda: string,
  options: TableRowOptions = {}
): Promise<Array<Record<string, unknown>>> {
  const { limit = 50, before, speed = "medium" } = options;
  return withRetry(() => iqlabs.reader.readTableRows(tablePda, { limit, before, speed }));
}

// Lightweight: only fetches the signature list (1 RPC call), no row data
export async function fetchRecentSignatures(
  tablePda: string,
  limit = 50,
  before?: string,
): Promise<string[]> {
  return withRetry(async () => {
    const pk = new PublicKey(tablePda);
    const opts: { limit: number; before?: string } = { limit };
    if (before) opts.before = before;
    const sigs = await solConnection.getSignaturesForAddress(pk, opts);
    return sigs.map((s: { signature: string }) => s.signature);
  });
}

// Read a single row by transaction signature.
// Returns null for non-row transactions (e.g. table creation).
export async function readSingleRow(sig: string): Promise<Record<string, unknown> | null> {
  return withRetry(async () => {
    let result;
    try {
      result = await iqlabs.reader.readCodeIn(sig);
    } catch (err) {
      // Skip transactions that aren't data rows (table creation, etc.)
      if (err instanceof Error && err.message.includes("instruction not found")) {
        return null;
      }
      throw err;
    }
    const { data, metadata } = result;
    if (!data) return { signature: sig, metadata, data: null };
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...parsed, __txSignature: sig };
      }
    } catch {}
    return { signature: sig, metadata, data };
  });
}

export async function fetchSignatureIndex(
  tablePda: string,
  maxSignatures = 10000,
): Promise<string[]> {
  return withRetry(() => iqlabs.reader.collectSignatures(tablePda, maxSignatures));
}

export async function readRowsBySignatures(
  signatures: string[],
  tablePda?: string,
): Promise<Array<Record<string, unknown>>> {
  return withRetry(() => iqlabs.reader.readTableRows(tablePda ?? signatures[0], { signatures }));
}
