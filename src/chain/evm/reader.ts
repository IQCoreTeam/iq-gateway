// EVM reader — thin caching wrapper around iq-ethereum-sdk + ethers.
//
// All gateway HTTP routes call into this module instead of the SDK directly,
// so we get one place for rate limiting, retry/fallback, and metrics.
//
// Multi-chain: `createEvmReader(network, rpc)` builds an independent reader bound
// to one EVM network (its own provider). The wrapper map (chain/wrappers.ts)
// builds one per configured network so a single process can serve sepolia +
// monad + monadTestnet at once. The module-level exports delegate to a default
// instance for back-compat (boot-time IQ_CHAIN=evm single-network path).
//
// SDK GLOBAL HAZARD: iqlabs keeps the active network/RPC in a package-level
// global (iqlabs.setNetwork). Two instances for different networks calling the
// SDK concurrently would clobber each other's global. So every SDK-touching job
// runs under a process-wide mutex (withSdkLock) that does setNetwork+call as one
// unit. Pure provider reads use the instance's own provider and don't need it,
// but for simplicity the whole retry job runs under the lock when it may touch
// the SDK. Per-call SDK context (no global) is the later optimization that lifts
// this serialization — see PR #11 thread.

import { JsonRpcProvider, isAddress, formatEther } from "ethers";
import { createHash } from "node:crypto";
import iqlabs from "@iqlabs-official/ethereum-sdk";
import { NetworkMode, NETWORKS, isNetworkMode } from "./networks";
import { isAlchemyEnabled, alchemyRpcUrl } from "./alchemy";
import { recordSignerSig } from "./signer-index";
import { enqueueRpc, getQueueStats, type Priority } from "../rpc-queue";

type Row = Record<string, unknown>;

// ─── Process-wide SDK mutex ──────────────────────────────────────────────────
// Serializes setNetwork+SDK-call across all EVM instances so the package global
// is never mid-swapped. A promise chain is enough (single-threaded event loop).
let sdkChain: Promise<unknown> = Promise.resolve();
function withSdkLock<T>(network: NetworkMode, rpc: string, fn: () => Promise<T>): Promise<T> {
  const run = sdkChain.then(async () => {
    iqlabs.setNetwork(network, rpc);
    return fn();
  });
  // Keep the chain alive even if this job rejects.
  sdkChain = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

// ─── Pure helpers (chain-agnostic; no network/provider) ──────────────────────

export function generateETag(content: string | Buffer): string {
  return `"${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
}

export function decodeAssetData(data: string): Buffer {
  if (typeof data !== "string") return Buffer.from("");
  if (data.startsWith("data:")) return Buffer.from(data.split(",")[1], "base64");
  if (data.startsWith("0x")) {
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

// ─── Per-network reader instance ─────────────────────────────────────────────

// Return type is inferred from the factory below (so SDK return shapes flow
// through to callers exactly as the old module-level exports did) and published
// as `EvmReader` after the definition.
export function createEvmReader(network: NetworkMode, rpcOverride?: string) {
  const config = NETWORKS[network];
  const primaryRpc = alchemyRpcUrl(network) || rpcOverride || config.defaultRpc;
  const fallbackRpc = rpcOverride || config.defaultRpc;

  let provider = new JsonRpcProvider(primaryRpc);
  let primary = true;
  const metrics = { totalCalls: 0, errors: 0, fallbacks: 0 };

  // Runs fn inside: rpc-queue admission → SDK mutex (setNetwork) → retry loop.
  async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, priority: Priority = "interactive"): Promise<T> {
    metrics.totalCalls++;
    return enqueueRpc(priority, () =>
      withSdkLock(network, primary ? primaryRpc : fallbackRpc, async () => {
        for (let i = 0; i <= maxRetries; i++) {
          try {
            return await fn();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if ((msg.includes("429") || msg.includes("rate") || msg.includes("Too Many")) && i < maxRetries) {
              const delay = 1000 * 2 ** i;
              console.warn(`[evm:${network}] 429/rate-limited, retry ${i + 1}/${maxRetries} after ${delay}ms`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            if (primary && i === 0 && (
              msg.includes("fetch failed") || msg.includes("ECONNREFUSED") ||
              msg.includes("503") || msg.includes("could not detect network")
            )) {
              metrics.fallbacks++;
              console.warn(`[evm:${network}] primary RPC failed (${msg}), trying fallback`);
              iqlabs.setNetwork(network, fallbackRpc);
              provider = new JsonRpcProvider(fallbackRpc);
              primary = false;
              try { return await fn(); }
              finally {
                iqlabs.setNetwork(network, primaryRpc);
                provider = new JsonRpcProvider(primaryRpc);
                primary = true;
              }
            }
            metrics.errors++;
            throw e;
          }
        }
        throw new Error("unreachable");
      }),
    );
  }

  return {
    network,
    config,
    getProvider: () => provider,
    getRpcMetrics: () => ({ ...metrics, network, alchemyEnabled: isAlchemyEnabled(), queue: getQueueStats() }),

    readAsset(txHash: string) {
      return withRetry(async () => {
        const tx = await provider.getTransaction(txHash);
        if (!tx) throw new Error("transaction not found");
        const signer = tx.from;
        const blockTime = tx.blockNumber ? (await provider.getBlock(tx.blockNumber))?.timestamp : undefined;
        const blockNumber = tx.blockNumber ?? null;
        try {
          const codeIn = await iqlabs.reader.readCodeIn(txHash);
          return { data: codeIn.data, metadata: codeIn.metadata, signer, blockTime, blockNumber };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Unexpected function")) throw err;
        }
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
    },

    listUserAssets(userAddress: string, limit = 20, before?: string) {
      return withRetry(async () => {
        const entries = await iqlabs.reader.fetchInventoryTransactions(userAddress, { limit: limit * 4 });
        let start = 0;
        if (before) {
          const idx = entries.findIndex((e: { txHash: string }) => e.txHash === before);
          if (idx >= 0) start = idx + 1;
        }
        return entries.slice(start, start + limit);
      });
    },

    readUserState(userAddress: string) {
      return withRetry(() => iqlabs.reader.readUserState(userAddress));
    },
    fetchUserConnections(userAddress: string) {
      return withRetry(() => iqlabs.reader.fetchUserConnections(userAddress));
    },
    readConnectionRows(dbRootId: string, partyA: string, partyB: string, opts?: { limit?: number }) {
      return withRetry(() => iqlabs.reader.readConnectionRows(dbRootId, partyA, partyB, opts));
    },
    readConnection(dbRootId: string, partyA: string, partyB: string) {
      return withRetry(() => iqlabs.reader.readConnection(dbRootId, partyA, partyB));
    },
    getTablelistFromRoot(dbRootId: string) {
      return withRetry(() => iqlabs.reader.getTablelistFromRoot(dbRootId));
    },
    fetchTableMeta(dbRootId: string, tableName: string) {
      return withRetry(() => iqlabs.reader.fetchTableMeta(dbRootId, tableName));
    },

    readTableRows(dbRootId: string, tableName: string, opts?: { limit?: number }) {
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
    },

    readSingleRow(txHash: string): Promise<Row | null> {
      return withRetry(async () => {
        const tx = await provider.getTransaction(txHash);
        if (!tx) return null;
        const signer = tx.from;
        const blockTime = tx.blockNumber ? (await provider.getBlock(tx.blockNumber))?.timestamp : undefined;
        try {
          const codeIn = await iqlabs.reader.readCodeIn(txHash);
          return formatRow(txHash, codeIn.data, codeIn.metadata, signer, blockTime);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Unexpected function")) throw err;
        }
        try {
          const contract = iqlabs.contract.getContract(provider);
          const parsed = contract.interface.parseTransaction({ data: tx.data });
          if (!parsed) return null;
          const DB_CODE_FNS = new Set(["dbCodeIn", "dbInstructionCodeIn", "walletConnectionCodeIn"]);
          if (!DB_CODE_FNS.has(parsed.name)) return null;
          const onChainPath: string = parsed.args[2] ?? "";
          const metadata: string = parsed.args[3] ?? "";
          if (onChainPath && onChainPath !== "" && onChainPath !== "0x") return null;
          return formatRow(txHash, metadata, null, signer, blockTime);
        } catch {
          return null;
        }
      });
    },

    getNativeBalance(address: string): Promise<{ wei: bigint; formatted: string }> {
      if (!isAddress(address)) return Promise.reject(new Error("invalid address"));
      return withRetry(async () => {
        const wei = await provider.getBalance(address);
        return { wei, formatted: formatEther(wei) };
      });
    },
  };
}

/** A per-network EVM reader (the inferred shape of createEvmReader's result). */
export type EvmReader = ReturnType<typeof createEvmReader>;

// ─── Default instance + back-compat module exports ───────────────────────────
// Import-safe: in Solana mode this module may be imported by the chain barrel,
// so we must NOT throw at top level. Falls back to "sepolia" shape so consts
// stay defined; strict validation lives in initEvm().

const ENV_NETWORK = process.env.IQETH_NETWORK;
export const NETWORK: NetworkMode = isNetworkMode(ENV_NETWORK) ? ENV_NETWORK : "sepolia";
export const NETWORK_CONFIG = NETWORKS[NETWORK];

let _default: EvmReader = createEvmReader(NETWORK, process.env.IQETH_RPC_ENDPOINT);

/** Boot-time EVM wiring for the single-network (IQ_CHAIN=evm) path. Validates
 *  IQETH_NETWORK strictly and (re)builds the default instance. */
export function initEvm(): void {
  if (!isNetworkMode(ENV_NETWORK)) {
    throw new Error(
      `IQETH_NETWORK not set or invalid (got "${ENV_NETWORK}"). ` +
      `Expected one of: sepolia | monad | monadTestnet`,
    );
  }
  _default = createEvmReader(ENV_NETWORK, process.env.IQETH_RPC_ENDPOINT);
  if (isAlchemyEnabled()) {
    console.log("[reader] Alchemy enabled — using batched provider + higher limits");
  }
}

export function getProvider(): JsonRpcProvider { return _default.getProvider(); }
export function getRpcMetrics() { return _default.getRpcMetrics(); }
export function readAsset(txHash: string) { return _default.readAsset(txHash); }
export function listUserAssets(a: string, l = 20, b?: string) { return _default.listUserAssets(a, l, b); }
export function readUserState(a: string) { return _default.readUserState(a); }
export function fetchUserConnections(a: string) { return _default.fetchUserConnections(a); }
export function readConnectionRows(d: string, a: string, b: string, o?: { limit?: number }) { return _default.readConnectionRows(d, a, b, o); }
export function readConnection(d: string, a: string, b: string) { return _default.readConnection(d, a, b); }
export function getTablelistFromRoot(d: string) { return _default.getTablelistFromRoot(d); }
export function fetchTableMeta(d: string, t: string) { return _default.fetchTableMeta(d, t); }
export function readTableRows(d: string, t: string, o?: { limit?: number }) { return _default.readTableRows(d, t, o); }
export function readSingleRow(txHash: string) { return _default.readSingleRow(txHash); }
export function getNativeBalance(address: string) { return _default.getNativeBalance(address); }

export { iqlabs };
