// Chain barrel — selection glue only.
//
// Route sets import their chain's CONCRETE surface directly (routes/* →
// ./solana, routes/evm/* → ./evm) so they keep precise per-chain types. This
// barrel intentionally does NOT re-export the shared functions: picking them by
// a runtime ternary would collapse their return types into a union (Solana | EVM)
// and break callers written against one chain. The only cross-chain concerns
// here are: which chain is active, and wiring it at boot.

import { activeChain } from "./types";
import { initEvm } from "./evm/reader";

export { activeChain, type ChainKind, type ChainReader, type Row, type AssetResult, type TableMeta } from "./types";

/** Boot-time chain wiring. EVM defers provider/network setup (and strict
 *  IQETH_NETWORK validation) into initEvm(); Solana wires RPC at module load,
 *  so there is nothing to do for it here. */
export function initChain(): void {
  if (activeChain() === "evm") initEvm();
}
