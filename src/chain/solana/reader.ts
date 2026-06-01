import { Connection, PublicKey } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import iqlabs from "@iqlabs-official/solana-sdk";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  isHeliusEnabled,
  HELIUS_RPC,
  heliusGetAllSignatures,
  heliusGetSignatures,
  heliusBatchGetTransactions,
} from "./helius";
import { enqueueRpc, getQueueStats, type Priority } from "../rpc-queue";

const PRIMARY_RPC = HELIUS_RPC || process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const FALLBACK_RPC = process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

iqlabs.setRpcUrl(PRIMARY_RPC);
let solConnection = new Connection(PRIMARY_RPC);

if (isHeliusEnabled()) {
  console.log("[reader] Helius RPC enabled — using batch transactions + enhanced endpoints");
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
    queue: getQueueStats(),
  };
}

// ─── Queue + retry wrapper ───────────────────────────────────────────────────
//
// Every call goes through the in-process queue (src/chain/rpc-queue.ts). The
// retry logic stays here — it's about RPC failure modes, not scheduling, so it
// runs inside the job after admission. 429 backoffs voluntarily yield the slot
// before retrying so a struggling key doesn't hog concurrency.

async function withRetry<T>(
  fn: () => Promise<T>,
  priority: Priority = "interactive",
  maxRetries = 2,
): Promise<T> {
  return enqueueRpc(priority, async () => {
    metrics.totalCalls++;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        if (msg.includes("429") && i < maxRetries) {
          metrics.rateLimited++;
          const delay = 1000 * 2 ** i;
          console.warn(`[reader] 429 rate-limited, retry ${i + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (i === 0 && (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("503") || msg.includes("max usage reached"))) {
          metrics.fallbacks++;
          console.warn(`[reader] Primary RPC failed (${msg}), trying fallback`);
          iqlabs.setRpcUrl(FALLBACK_RPC);
          solConnection = new Connection(FALLBACK_RPC);
          try {
            return await fn();
          } finally {
            iqlabs.setRpcUrl(PRIMARY_RPC);
            solConnection = new Connection(PRIMARY_RPC);
          }
        }

        metrics.errors++;
        throw e;
      }
    }
    throw new Error("unreachable");
  });
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
  const tx = await withRetry(() =>
    solConnection.getTransaction(txSig, { maxSupportedTransactionVersion: 0 }),
  );
  if (!tx) throw new Error("transaction not found");

  const result = await iqlabs.reader.readUserInventoryCodeInFromTx(tx);
  const signer = tx.transaction.message.getAccountKeys().get(0)?.toBase58();

  return {
    ...result,
    signer,
    blockTime: tx.blockTime ?? null,
    slot: tx.slot,
  };
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

export async function fetchUserConnections(userPubkey: string) {
  return withRetry(() => iqlabs.reader.fetchUserConnections(userPubkey, { speed: 'medium' }));
}

export async function fetchRecentSignatures(
  tablePda: string,
  limit = 50,
  before?: string,
): Promise<string[]> {
  if (isHeliusEnabled()) {
    try {
      metrics.heliusCalls++;
      metrics.totalCalls++;
      return await heliusGetSignatures(tablePda, limit, before, "interactive");
    } catch (e) {
      console.warn("[reader] Helius sig fetch failed, falling back:", e instanceof Error ? e.message : e);
    }
  }

  return withRetry(async () => {
    const sigs = await solConnection.getSignaturesForAddress(
      new PublicKey(tablePda), { limit, ...(before && { before }) },
    );
    return sigs.map((s: { signature: string }) => s.signature);
  });
}

function formatRow(
  sig: string,
  data: string | null,
  metadata: string,
  signer?: string,
  blockTime?: number,
  onChainPath?: string,
): Record<string, unknown> {
  let row: Record<string, unknown>;
  if (!data) {
    row = { signature: sig, metadata, data: null };
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch {}
    row = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), __txSignature: sig }
      : { signature: sig, metadata, data };
  }
  if (signer) row.__signer = signer;
  if (typeof blockTime === "number") row.__blockTime = blockTime;
  // Truth from the contract: empty string = inline (metadata-only), non-empty
  // = linked-list head or session pda. Caller may omit (undefined) when the
  // decode path didn't expose it.
  if (typeof onChainPath === "string") row.__onChainPath = onChainPath;
  // Index the signer→sig mapping here so every formatted row gets recorded
  // regardless of which decode path produced it. Cheap (memory + disk).
  if (signer) recordSignerSig(signer, sig);
  return row;
}

/**
 * Extracts fee-payer + block time from a Helius raw tx JSON (no web3.js classes).
 * Used by both decodeRawTxRow and readMultipleRows' fallback path so the two
 * decoders share one normalization.
 */
function extractRawTxMeta(raw: any): { signer?: string; blockTime?: number; accountKeys: string[] } {
  const msg = raw?.transaction?.message;
  const accountKeys: string[] = msg?.accountKeys
    ? (typeof msg.accountKeys[0] === "string" ? msg.accountKeys : msg.accountKeys.map((k: any) => k.pubkey ?? k))
    : [];
  return {
    signer: accountKeys[0],
    blockTime: typeof raw?.blockTime === "number" ? raw.blockTime : undefined,
    accountKeys,
  };
}

export async function readSingleRow(
  sig: string,
  preloaded?: { signer?: string; blockTime?: number; onChainPath?: string },
): Promise<Record<string, unknown> | null> {
  return withRetry(async () => {
    try {
      // Skip getTransaction when the caller already pulled signer+blockTime from
      // a Helius raw tx — kills one redundant RPC on the Helius-succeeded-but-
      // undecodable path (see readMultipleRows fallback).
      const needTx = !preloaded || preloaded.signer === undefined || preloaded.blockTime === undefined;
      const [codeIn, tx] = await Promise.all([
        iqlabs.reader.readCodeIn(sig),
        needTx ? solConnection.getTransaction(sig, { maxSupportedTransactionVersion: 0 }) : Promise.resolve(null),
      ]);
      const signer = preloaded?.signer ?? tx?.transaction.message.getAccountKeys().get(0)?.toBase58();
      const blockTime = preloaded?.blockTime ?? (tx?.blockTime ?? undefined);
      return formatRow(sig, codeIn.data, codeIn.metadata, signer, blockTime, preloaded?.onChainPath);
    } catch (err) {
      if (err instanceof Error && err.message.includes("instruction not found")) {
        return null;
      }
      throw err;
    }
  });
}

// Decode code_in instructions from raw Helius batch JSON (no web3.js class methods).

const PROGRAM_ID_B58 = "9KLLchQVJpGkw4jPuUmnvqESdR7mtNCYr3qS4iQLabs";
import { contract } from "@iqlabs-official/solana-sdk";
import { recordSignerSig } from "./signer-index";
const instructionCoder = new BorshInstructionCoder(contract.IQ_IDL);
const CODE_IN_NAMES = new Set([
  "user_inventory_code_in", "user_inventory_code_in_for_free",
  "db_code_in", "db_instruction_code_in", "wallet_connection_code_in",
]);

// Returns the decoded row when the fast path can handle it, otherwise returns
// the onChainPath we observed so the SDK fallback can stamp it on the result.
// onChainPath = undefined means "not a recognized code_in instruction at all".
function decodeRawTxRow(
  sig: string,
  raw: any,
  meta: { signer?: string; blockTime?: number; accountKeys: string[] },
): { row: Record<string, unknown> | null; onChainPath?: string } {
  if (!raw?.transaction?.message) return { row: null };
  const { signer, blockTime, accountKeys } = meta;
  const msg = raw.transaction.message;
  const ixs: Array<{ programIdIndex: number; data: string }> =
    msg.instructions ?? msg.compiledInstructions ?? [];

  for (const ix of ixs) {
    if (accountKeys[ix.programIdIndex] !== PROGRAM_ID_B58) continue;
    const decoded = instructionCoder.decode(Buffer.from(bs58.decode(ix.data)));
    if (!decoded || !CODE_IN_NAMES.has(decoded.name)) continue;

    const d = decoded.data as { on_chain_path?: string; metadata?: string };
    const onChainPath = d.on_chain_path ?? "";
    const metadata = d.metadata ?? "";

    // Session/linked-list posts need full SDK decode — but we've already
    // observed onChainPath, so pass it back so the fallback can include it.
    if (onChainPath.length > 0) return { row: null, onChainPath };

    try {
      const parsed = JSON.parse(metadata);
      if (parsed?.data) {
        const rowData = typeof parsed.data === "string" ? parsed.data : JSON.stringify(parsed.data);
        return { row: formatRow(sig, rowData, metadata, signer, blockTime, onChainPath) };
      }
    } catch {}
    return { row: formatRow(sig, null, metadata, signer, blockTime, onChainPath) };
  }
  return { row: null };
}

export async function fetchSignatureIndex(
  tablePda: string,
  maxSignatures = 10000,
): Promise<string[]> {
  // Heavy: paginates getSignaturesForAddress up to maxSignatures. Per-page
  // queue priority is "background" so it can't crowd out live row reads.
  if (isHeliusEnabled()) {
    try {
      metrics.heliusCalls++;
      metrics.totalCalls++;
      return await heliusGetAllSignatures(tablePda, maxSignatures, "background");
    } catch (e) {
      console.warn("[reader] Helius index fetch failed, falling back:", e instanceof Error ? e.message : e);
    }
  }

  return withRetry(() => iqlabs.reader.collectSignatures(tablePda, maxSignatures), "background");
}

export async function readRowsBySignatures(
  signatures: string[],
  tablePda?: string,
): Promise<Array<Record<string, unknown>>> {
  return withRetry(() => iqlabs.reader.readTableRows(tablePda ?? signatures[0], { signatures }));
}

export async function readMultipleRows(
  signatures: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const results = new Map<string, Record<string, unknown> | null>();
  if (signatures.length === 0) return results;

  const needsFullDecode: string[] = [];

  // Keeps the Helius raw tx for sigs that couldn't fast-decode, so the
  // SDK fallback can reuse signer+blockTime instead of refetching the tx.
  // Also carries onChainPath when we observed it during fast-decode — the
  // SDK fallback can't recover it from readCodeIn alone.
  const preloadMap = new Map<string, { signer?: string; blockTime?: number; onChainPath?: string }>();

  if (isHeliusEnabled()) {
    try {
      metrics.heliusCalls++;
      metrics.totalCalls++;
      const txMap = await heliusBatchGetTransactions(signatures, "background");
      for (const sig of signatures) {
        const raw = txMap.get(sig);
        if (!raw) { results.set(sig, null); continue; }
        const meta = extractRawTxMeta(raw);
        const { row, onChainPath } = decodeRawTxRow(sig, raw, meta);
        if (row) {
          results.set(sig, row);
        } else {
          // null = non-row tx or session/linked-list — try full SDK decode
          preloadMap.set(sig, { signer: meta.signer, blockTime: meta.blockTime, onChainPath });
          needsFullDecode.push(sig);
        }
      }
    } catch {
      needsFullDecode.push(...signatures.filter(s => !results.has(s)));
    }
  } else {
    needsFullDecode.push(...signatures);
  }

  // Fall back to readSingleRow for anything the batch couldn't decode
  const CONCURRENCY = isHeliusEnabled() ? 20 : 5;
  for (let i = 0; i < needsFullDecode.length; i += CONCURRENCY) {
    const chunk = needsFullDecode.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (sig) => ({ sig, row: await readSingleRow(sig, preloadMap.get(sig)) })),
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
