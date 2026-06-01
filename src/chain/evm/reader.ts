// EVM reader — thin caching wrapper around iq-ethereum-sdk + ethers.
//
// All gateway HTTP routes call into this module instead of the SDK directly,
// so we get one place for rate limiting, retry/fallback, and metrics.
// Mirrors iq-gateway/src/chain/reader.ts shape so the rest of the codebase
// can stay near-identical to the Solana version.

import { JsonRpcProvider, isAddress, formatEther } from "ethers";
import { createHash } from "node:crypto";
import iqlabs from "@iqlabs-official/ethereum-sdk";
import { NetworkMode, NETWORKS, isNetworkMode } from "./networks";
import { isAlchemyEnabled, alchemyRpcUrl } from "./alchemy";
import { recordSignerSig } from "./signer-index";
import { enqueueRpc, getQueueStats } from "./rpc-queue";

// Import-safe network resolution. In Solana mode (IQ_CHAIN!=evm) this module
// may still be imported by the chain barrel, so we must NOT throw here. The
// strict validation lives in initEvm(), called by server.ts only when the EVM
// adapter is active. Falls back to "sepolia" shape so consts stay defined.
const ENV_NETWORK = process.env.IQETH_NETWORK;
export const NETWORK: NetworkMode = isNetworkMode(ENV_NETWORK) ? ENV_NETWORK : "sepolia";
export const NETWORK_CONFIG = NETWORKS[NETWORK];

const PRIMARY_RPC =
  alchemyRpcUrl(NETWORK) ||
  process.env.IQETH_RPC_ENDPOINT ||
  NETWORK_CONFIG.defaultRpc;
const FALLBACK_RPC = process.env.IQETH_RPC_ENDPOINT || NETWORK_CONFIG.defaultRpc;

// JsonRpcProvider construction is lazy (no network call), so this is import-safe.
let provider = new JsonRpcProvider(PRIMARY_RPC);
let primary = true;

/** Boot-time EVM wiring. Validates IQETH_NETWORK strictly and points the SDK at
 *  the chosen RPC. Called by server.ts only when IQ_CHAIN=evm. */
export function initEvm(): void {
  if (!isNetworkMode(ENV_NETWORK)) {
    throw new Error(
      `IQETH_NETWORK not set or invalid (got "${ENV_NETWORK}"). ` +
      `Expected one of: sepolia | monad | monadTestnet`,
    );
  }
  iqlabs.setNetwork(NETWORK, PRIMARY_RPC);
  provider = new JsonRpcProvider(PRIMARY_RPC);
  primary = true;
  if (isAlchemyEnabled()) {
    console.log("[reader] Alchemy enabled — using batched provider + higher limits");
  }
}

// ─── Metrics (kept for /health compat) ───────────────────────────────────────

const metrics = {
  totalCalls: 0,
  errors: 0,
  fallbacks: 0,
};

export function getRpcMetrics() {
  return {
    ...metrics,
    network: NETWORK,
    alchemyEnabled: isAlchemyEnabled(),
    queue: getQueueStats(),
  };
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  priority: import("./rpc-queue").Priority = "interactive",
): Promise<T> {
  metrics.totalCalls++;

  return enqueueRpc(priority, async () => {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);

        if ((msg.includes("429") || msg.includes("rate") || msg.includes("Too Many")) && i < maxRetries) {
          const delay = 1000 * 2 ** i;
          console.warn(`[reader] 429/rate-limited, retry ${i + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (primary && i === 0 && (
          msg.includes("fetch failed") || msg.includes("ECONNREFUSED") ||
          msg.includes("503") || msg.includes("could not detect network")
        )) {
          metrics.fallbacks++;
          console.warn(`[reader] Primary RPC failed (${msg}), trying fallback`);
          iqlabs.setNetwork(NETWORK, FALLBACK_RPC);
          provider = new JsonRpcProvider(FALLBACK_RPC);
          primary = false;
          try { return await fn(); }
          finally {
            iqlabs.setNetwork(NETWORK, PRIMARY_RPC);
            provider = new JsonRpcProvider(PRIMARY_RPC);
            primary = true;
          }
        }

        metrics.errors++;
        throw e;
      }
    }
    throw new Error("unreachable");
  });
}

// ─── Public helpers ──────────────────────────────────────────────────────────

export function generateETag(content: string | Buffer): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
}

export function decodeAssetData(data: string): Buffer {
  if (typeof data !== "string") return Buffer.from("");
  if (data.startsWith("data:")) return Buffer.from(data.split(",")[1], "base64");
  if (data.startsWith("0x")) {
    // hex-encoded calldata payload
    try { return Buffer.from(data.slice(2), "hex"); } catch {}
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

export function getProvider(): JsonRpcProvider {
  return provider;
}

// ─── Reader exports ──────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function formatRow(
  txHash: string,
  data: unknown,
  metadata: Record<string, string> | string | null,
  signer?: string,
  blockTime?: number,
): Row {
  const metaStr = typeof metadata === "string" ? metadata : metadata ? JSON.stringify(metadata) : "";
  let row: Row;
  if (data == null) {
    row = { txHash, metadata: metaStr, data: null };
  } else if (typeof data === "string") {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch {}
    row = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Row), __txHash: txHash }
      : { txHash, metadata: metaStr, data };
  } else if (typeof data === "object" && !Array.isArray(data)) {
    row = { ...(data as Row), __txHash: txHash };
  } else {
    row = { txHash, metadata: metaStr, data };
  }
  if (signer) row.__signer = signer;
  if (typeof blockTime === "number") row.__blockTime = blockTime;
  if (signer) recordSignerSig(signer, txHash);
  return row;
}

/**
 * Returns asset payload for any IQ tx. Handles userInventoryCodeIn and
 * dbCodeIn (inline) so /view and /render work on table row txs too.
 */
export async function readAsset(txHash: string) {
  return withRetry(async () => {
    const tx = await provider.getTransaction(txHash);
    if (!tx) throw new Error("transaction not found");
    const signer = tx.from;
    const blockTime = tx.blockNumber ? (await provider.getBlock(tx.blockNumber))?.timestamp : undefined;
    const blockNumber = tx.blockNumber ?? null;

    // Try userInventoryCodeIn first
    try {
      const codeIn = await iqlabs.reader.readCodeIn(txHash);
      return { data: codeIn.data, metadata: codeIn.metadata, signer, blockTime, blockNumber };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("Unexpected function")) throw err;
    }

    // Fallback: decode dbCodeIn inline (onChainPath empty)
    const contract = iqlabs.contract.getContract(provider);
    const parsed = contract.interface.parseTransaction({ data: tx.data });
    if (!parsed) throw new Error("unknown transaction type");

    const DB_CODE_FNS = new Set(["dbCodeIn", "dbInstructionCodeIn", "walletConnectionCodeIn"]);
    if (!DB_CODE_FNS.has(parsed.name)) throw new Error(`Unexpected function: ${parsed.name}`);

    const onChainPath: string = parsed.args[2] ?? "";
    const data: string = parsed.args[3] ?? "";
    if (onChainPath && onChainPath !== "" && onChainPath !== "0x") {
      throw new Error("linked-list dbCodeIn not supported in readAsset — use /table/.../rows");
    }
    return { data, metadata: {} as Record<string, string>, signer, blockTime, blockNumber };
  });
}

export async function listUserAssets(userAddress: string, limit = 20, before?: string) {
  // SDK's fetchInventoryTransactions walks tx-chain pointers. `before` is an
  // optional override of the chain tail to resume mid-walk. We approximate by
  // slicing the returned list when `before` is supplied (SDK doesn't accept
  // a cursor today).
  return withRetry(async () => {
    const entries = await iqlabs.reader.fetchInventoryTransactions(userAddress, { limit: limit * 4 });
    let start = 0;
    if (before) {
      const idx = entries.findIndex((e: { txHash: string }) => e.txHash === before);
      if (idx >= 0) start = idx + 1;
    }
    return entries.slice(start, start + limit);
  });
}

export async function readUserState(userAddress: string) {
  return withRetry(async () => {
    const state = await iqlabs.reader.readUserState(userAddress);
    return state;
  });
}

export async function fetchUserConnections(userAddress: string) {
  return withRetry(() => iqlabs.reader.fetchUserConnections(userAddress));
}

export async function readConnectionRows(dbRootId: string, partyA: string, partyB: string, opts?: { limit?: number }) {
  return withRetry(() => iqlabs.reader.readConnectionRows(dbRootId, partyA, partyB, opts));
}

export async function readConnection(dbRootId: string, partyA: string, partyB: string) {
  return withRetry(() => iqlabs.reader.readConnection(dbRootId, partyA, partyB));
}

export async function getTablelistFromRoot(dbRootId: string) {
  return withRetry(() => iqlabs.reader.getTablelistFromRoot(dbRootId));
}

export async function fetchTableMeta(dbRootId: string, tableName: string) {
  return withRetry(() => iqlabs.reader.fetchTableMeta(dbRootId, tableName));
}

/** Walk a table's tx-chain pointers and return reconstructed rows.
 *  Returns rows newest-first with __txHash stamped on each. */
export async function readTableRows(dbRootId: string, tableName: string, opts?: { limit?: number }) {
  return withRetry(async () => {
    const raw = await iqlabs.reader.readTableRows(dbRootId, tableName, opts);
    const rows: Row[] = [];
    for (const e of raw) {
      const tx = await provider.getTransaction(e.txHash).catch(() => null);
      const signer = tx?.from;
      const blockNum = tx?.blockNumber;
      const blockTime = blockNum ? (await provider.getBlock(blockNum))?.timestamp : undefined;
      rows.push(formatRow(e.txHash, e.data, null, signer, blockTime));
    }
    return rows;
  });
}

/**
 * Decode any IQ tx into a row. Handles both:
 *   - userInventoryCodeIn (codeIn asset uploads) via SDK readCodeIn
 *   - dbCodeIn (table row writes) via contract interface directly
 *
 * dbCodeIn calldata layout: (rootIdBytes, tableSeed, onChainPath, metadata, beforeDataTx)
 * When onChainPath is empty, metadata IS the row JSON (inline). When non-empty it's
 * a linked-list head — we fall back to null (linked-list table rows served via /rows).
 */
export async function readSingleRow(txHash: string): Promise<Row | null> {
  return withRetry(async () => {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return null;
    const signer = tx.from;
    const blockTime = tx.blockNumber ? (await provider.getBlock(tx.blockNumber))?.timestamp : undefined;

    // Fast path: try userInventoryCodeIn (asset uploads)
    try {
      const codeIn = await iqlabs.reader.readCodeIn(txHash);
      return formatRow(txHash, codeIn.data, codeIn.metadata, signer, blockTime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If not "unexpected function" then it's a real error — rethrow
      if (!msg.includes("Unexpected function")) throw err;
    }

    // Second path: decode dbCodeIn / dbInstructionCodeIn / walletConnectionCodeIn
    try {
      const contract = iqlabs.contract.getContract(provider);
      const parsed = contract.interface.parseTransaction({ data: tx.data });
      if (!parsed) return null;
      const DB_CODE_FNS = new Set([
        "dbCodeIn", "dbInstructionCodeIn", "walletConnectionCodeIn",
      ]);
      if (!DB_CODE_FNS.has(parsed.name)) return null;

      // onChainPath = arg[2], metadata = arg[3]
      const onChainPath: string = parsed.args[2] ?? "";
      const metadata: string = parsed.args[3] ?? "";

      // Linked-list rows need full chain walk — not possible on a single tx.
      // Return null so callers fall back to /table/.../rows.
      if (onChainPath && onChainPath !== "" && onChainPath !== "0x") return null;

      return formatRow(txHash, metadata, null, signer, blockTime);
    } catch {
      return null;
    }
  });
}

/** Native balance in the network's currency unit. */
export async function getNativeBalance(address: string): Promise<{ wei: bigint; formatted: string }> {
  if (!isAddress(address)) throw new Error("invalid address");
  return withRetry(async () => {
    const wei = await provider.getBalance(address);
    return { wei, formatted: formatEther(wei) };
  });
}

export { iqlabs };
