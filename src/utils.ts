import { PublicKey } from "@solana/web3.js";
import { isAddress } from "ethers";

/** Cheap base58+length check for a Solana pubkey string. Used by every
 *  route that takes a PDA or wallet in the URL so we reject bad input at
 *  the edge rather than constructing an invalid PublicKey mid-handler. */
export function isValidPublicKey(key: string): boolean {
  try { new PublicKey(key); return true; } catch { return false; }
}

// ─── EVM id validators (used by routes/evm/*) ────────────────────────────────

/** EVM tx hash: 0x-prefixed 64 hex chars. */
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isTxHash(s: string): boolean {
  return typeof s === "string" && HASH_RE.test(s);
}

/** EVM 20-byte address. Uses ethers' checksummed validator. */
export function isEvmAddress(s: string): boolean {
  return typeof s === "string" && isAddress(s);
}
