import { PublicKey } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import { createHash } from "node:crypto";

const PRIMARY_RPC = process.env.SOLANA_RPC_ENDPOINT || "https://devnet.helius-rpc.com/?api-key=335ec619-5f09-49a4-b1f9-021be2d645bb";
const FALLBACK_RPC = "https://api.devnet.solana.com";

iqlabs.setRpcUrl(PRIMARY_RPC);

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429") && i < maxRetries) {
        console.warn(`[reader] 429 rate-limited, retry ${i + 1}/${maxRetries} after ${1000 * 2 ** i}ms`);
        await new Promise(r => setTimeout(r, 1000 * 2 ** i));
        continue;
      }
      // On non-429 connection errors, try fallback RPC once
      if (i === 0 && (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("503"))) {
        console.warn(`[reader] Primary RPC failed (${msg}), switching to fallback`);
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
      throw e;
    }
  }
  throw new Error("unreachable");
}

type TableRowOptions = {
  limit?: number;
  before?: string;
  speed?: string;
};

export function generateETag(content: string | Buffer): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
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

// Fetch the full signature index for a table PDA.
// Returns signatures newest-first (chain default order).
export async function fetchSignatureIndex(
  tablePda: string,
  maxSignatures = 10000,
): Promise<string[]> {
  return withRetry(() => iqlabs.reader.collectSignatures(tablePda, maxSignatures));
}

// Decode specific transactions by signature.
// Returns parsed rows in the same format as readTableRows.
export async function readRowsBySignatures(
  signatures: string[],
  tablePda?: string,
): Promise<Array<Record<string, unknown>>> {
  return withRetry(() => iqlabs.reader.readTableRows(tablePda ?? signatures[0], { signatures }));
}
