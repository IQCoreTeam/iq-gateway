// The ChainReader seam — the *intersection* of operations both the Solana and
// EVM adapters implement. Routes that are chain-agnostic depend only on these.
//
// Operations that look shared but aren't (different algorithm or return shape)
// stay private to their adapter and are re-exported by name from chain/index.ts
// — never forced into this interface with ignored params. See PR #10.

/** A reconstructed row. Solana stamps `__txSignature`, EVM stamps `__txHash`;
 *  both stamp `__signer` / `__blockTime` when known. Callers treat it opaquely. */
export type Row = Record<string, unknown>;

/** Decoded asset payload returned by readAsset. `slot` (Solana) and
 *  `blockNumber` (EVM) are optional chain-specific provenance fields. */
export interface AssetResult {
  data: string | null;
  metadata: string | Record<string, string> | null;
  signer?: string;
  blockTime?: number | null;
  slot?: number;
  blockNumber?: number | null;
}

/** Normalized table metadata. `gate.amount` is `number` on Solana (SPL u64
 *  fits) and a decimal string on EVM (wei can exceed Number range). */
export interface TableMeta {
  name: string;
  columns?: string[];
  idCol?: string;
  lastTimestamp: number;
  gate: { mint: string; amount: number | string; gateType: number } | null;
}

/** The shared surface. Each adapter implements these; chain/index.ts selects
 *  one by IQ_CHAIN and re-exports its methods as the public chain barrel. */
export interface ChainReader {
  readAsset(id: string): Promise<AssetResult & Row>;
  readSingleRow(id: string, preloaded?: unknown): Promise<Row | null>;
  readUserState(address: string): Promise<unknown>;
  listUserAssets(address: string, limit?: number, before?: string): Promise<unknown[]>;
  fetchUserConnections(address: string): Promise<unknown>;
  getTableMetaCached(...args: string[]): Promise<TableMeta | null>;
  getSignerSigs(address: string, limit?: number): Promise<string[]> | string[];
  getRpcMetrics(): Record<string, unknown>;
  /** Boot-time RPC/provider wiring. Deferred out of module top-level so the
   *  inactive adapter can be imported without side-effects (no env throw). */
  init(): void;
}

export type ChainKind = "solana" | "evm";

export function activeChain(): ChainKind {
  return process.env.IQ_CHAIN === "evm" ? "evm" : "solana";
}
