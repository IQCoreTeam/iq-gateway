// Request-time chain resolver.
//
// One process can serve Solana + every EVM network at once. Which chain a
// request targets is decided here, from the URL, and attached to the Hono
// context as `chain` (the wrapper) + `network` (its name). Handlers then call
// `c.get("chain").readAsset(id)` instead of importing a fixed chain module.
//
// Resolution rules (see PR #11 thread):
//   1. `?network=` wins — the only way to reach an EVM L2 (monad / monadTestnet)
//      or to force solana. Unknown value → 400.
//   2. otherwise auto-detect from the id shape:
//        - base58 (Solana pubkey/sig)            → solana
//        - everything else (0x txHash/address,   → EVM default (sepolia)
//          or an arbitrary EVM dbRootId string)
//   3. id-less routes (/health, /dbroots, …) with no `?network` → default chain.
//
// Solana ids are ALWAYS base58, so "not base58" reliably means EVM. Garbage ids
// fall through to EVM and the handler 404s on lookup (never a 500 / wrong chain).

import type { Context, Next } from "hono";
import { isSolanaId } from "./utils";
import { NETWORKS, type NetworkMode, isNetworkMode } from "./chain/evm/networks";

export type ResolvedChain =
  | { chain: "solana"; network: "solana" }
  | { chain: "evm"; network: NetworkMode };

export type ResolveError = { error: string; status: 400 };

/** EVM network a bare `0x`/dbRootId id resolves to. Sepolia is the SDK default
 *  (Ethereum mainnet is not deployed). Override per-deployment if needed. */
export const EVM_DEFAULT_NETWORK: NetworkMode = isNetworkMode(process.env.IQETH_DEFAULT_NETWORK)
  ? process.env.IQETH_DEFAULT_NETWORK
  : "sepolia";

/** Default chain for id-less routes with no `?network` (e.g. /dbroots). Locks to
 *  one chain when IQ_CHAIN is set, else Solana (historical default). */
function defaultChain(): ResolvedChain {
  if (process.env.IQ_CHAIN === "evm") return { chain: "evm", network: EVM_DEFAULT_NETWORK };
  return { chain: "solana", network: "solana" };
}

/** Pure resolution — id is the candidate path id (may be undefined for id-less
 *  routes), networkParam is the raw `?network` query value. */
export function resolveChain(id: string | undefined, networkParam?: string): ResolvedChain | ResolveError {
  if (networkParam) {
    if (networkParam === "solana") return { chain: "solana", network: "solana" };
    if (isNetworkMode(networkParam)) return { chain: "evm", network: networkParam };
    return { error: `unknown network "${networkParam}" (expected: solana | ${Object.keys(NETWORKS).join(" | ")})`, status: 400 };
  }
  if (!id) return defaultChain();
  if (isSolanaId(id)) return { chain: "solana", network: "solana" };
  return { chain: "evm", network: EVM_DEFAULT_NETWORK };
}

/** Pull the candidate chain id out of a path. Convention: the segment right
 *  after the route prefix — `/{route}/{id}/...` — with any `.ext` stripped
 *  (/meta/0xabc.json → 0xabc). Returns undefined for id-less routes
 *  (/health, /dbroots, /search, /cache, /docs, ...). */
export function extractId(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const seg = parts[1];
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? seg.slice(0, dot) : seg;
}

/** A wrapper exposes the chain's surface; `kind` discriminates capability. */
export interface WrapperLike { kind: "solana" | "evm"; network: string }

/** Hono middleware: resolve per request and attach `chain` + `network`.
 *  `wrappers` is the prebuilt map (chain/wrappers.ts). A resolved network with
 *  no built wrapper (RPC not configured) → 503. */
export function chainResolver(wrappers: Record<string, WrapperLike>) {
  return async (c: Context, next: Next) => {
    const resolved = resolveChain(extractId(c.req.path), c.req.query("network"));
    if ("error" in resolved) return c.json({ error: resolved.error }, resolved.status);
    const wrapper = wrappers[resolved.network];
    if (!wrapper) {
      return c.json({ error: `network "${resolved.network}" not configured on this gateway` }, 503);
    }
    c.set("chain", wrapper);
    c.set("network", resolved.network);
    return next();
  };
}
