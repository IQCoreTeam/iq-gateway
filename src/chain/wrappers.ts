// Prebuilt chain-wrapper map.
//
// One object per supported (chain, network), built once at boot, each holding
// its own RPC/provider. The resolver (src/resolver.ts) picks one per request
// and attaches it as `ctx.chain`; handlers call `c.get("chain").readAsset(id)`
// instead of importing a fixed chain module.
//
// Shared surface (both chains): readAsset, readSingleRow, listUserAssets,
// readUserState, fetchUserConnections, getSignerSigs, getTableMetaCached,
// getRpcMetrics, generateETag, decodeAssetData, detectImageType.
// Chain-specific methods are optional and capability-gated by handlers via
// `kind` (e.g. EVM-only readTableRows/resolveEns, Solana-only listUserSessions/
// resolveDomainToSig). See the manager's note: table/gate/view/render genuinely
// diverge, so those handlers branch on `kind` rather than pretending one shape.

import * as sol from "./solana";
import { resolveDomainToSig, resolveDomainOwner, resolveDomainRecord } from "./solana/sns";
import {
  createEvmReader,
  generateETag as evmETag,
  decodeAssetData as evmDecode,
  detectImageType as evmDetectImg,
} from "./evm/reader";
import { createMetaCache } from "./evm/meta";
import { resolveEns, reverseEns } from "./evm/ens";
import { getSignerSigs as evmSignerSigs } from "./evm/signer-index";
import { isAlchemyEnabled } from "./evm/alchemy";
import { NETWORKS, type NetworkMode } from "./evm/networks";

// ─── Solana wrapper (single network) ─────────────────────────────────────────

export function buildSolanaWrapper() {
  return {
    kind: "solana" as const,
    network: "solana" as const,
    // shared surface
    readAsset: sol.readAsset,
    readSingleRow: sol.readSingleRow,
    listUserAssets: sol.listUserAssets,
    readUserState: sol.readUserState,
    fetchUserConnections: sol.fetchUserConnections,
    getSignerSigs: sol.getSignerSigs,
    getTableMetaCached: sol.getTableMetaCached,
    getRpcMetrics: sol.getRpcMetrics,
    generateETag: sol.generateETag,
    decodeAssetData: sol.decodeAssetData,
    detectImageType: sol.detectImageType,
    // solana-specific
    listUserSessions: sol.listUserSessions,
    fetchSignatureIndex: sol.fetchSignatureIndex,
    readMultipleRows: sol.readMultipleRows,
    fetchRecentSignatures: sol.fetchRecentSignatures,
    readRowsBySignatures: sol.readRowsBySignatures,
    isHeliusEnabled: sol.isHeliusEnabled,
    heliusGetTransactionsForAddress: sol.heliusGetTransactionsForAddress,
    resolveDomainToSig,
    resolveDomainOwner,
    resolveDomainRecord,
  };
}

export type SolanaWrapper = ReturnType<typeof buildSolanaWrapper>;

// ─── EVM wrapper (one per network) ───────────────────────────────────────────

/** Per-network RPC: IQETH_RPC_<NET> (e.g. IQETH_RPC_MONAD), then the legacy
 *  single IQETH_RPC_ENDPOINT, then the network's built-in default. */
function rpcForNetwork(network: NetworkMode): string {
  const perNet = process.env[`IQETH_RPC_${network.toUpperCase()}`];
  return perNet || process.env.IQETH_RPC_ENDPOINT || NETWORKS[network].defaultRpc;
}

export function buildEvmWrapper(network: NetworkMode) {
  const reader = createEvmReader(network, rpcForNetwork(network));
  const getTableMetaCached = createMetaCache(reader.fetchTableMeta);
  return {
    kind: "evm" as const,
    network,
    config: NETWORKS[network],
    // shared surface
    readAsset: reader.readAsset,
    readSingleRow: reader.readSingleRow,
    listUserAssets: reader.listUserAssets,
    readUserState: reader.readUserState,
    fetchUserConnections: reader.fetchUserConnections,
    getSignerSigs: evmSignerSigs,
    getTableMetaCached,
    getRpcMetrics: reader.getRpcMetrics,
    generateETag: evmETag,
    decodeAssetData: evmDecode,
    detectImageType: evmDetectImg,
    // evm-specific
    readTableRows: reader.readTableRows,
    getTablelistFromRoot: reader.getTablelistFromRoot,
    getNativeBalance: reader.getNativeBalance,
    fetchTableMeta: reader.fetchTableMeta,
    readConnection: reader.readConnection,
    readConnectionRows: reader.readConnectionRows,
    getProvider: reader.getProvider,
    resolveEns,
    reverseEns,
    isAlchemyEnabled,
  };
}

export type EvmWrapper = ReturnType<typeof buildEvmWrapper>;
export type ChainWrapper = SolanaWrapper | EvmWrapper;

// ─── The map ─────────────────────────────────────────────────────────────────

const EVM_NETWORKS = Object.keys(NETWORKS) as NetworkMode[];

/** Build the wrapper map for whichever chains this process should serve.
 *  IQ_CHAIN locks to one chain (back-compat single-chain deploys); unset builds
 *  Solana + every EVM network so one process serves all. */
export function buildWrappers(): Record<string, ChainWrapper> {
  const lock = process.env.IQ_CHAIN;
  const map: Record<string, ChainWrapper> = {};
  const wantSolana = !lock || lock === "solana";
  const wantEvm = !lock || lock === "evm";
  if (wantSolana) map.solana = buildSolanaWrapper();
  if (wantEvm) for (const net of EVM_NETWORKS) map[net] = buildEvmWrapper(net);
  return map;
}
