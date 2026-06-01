import { PublicKey } from "@solana/web3.js";
import { isAddress } from "ethers";
import bs58 from "bs58";

/** Cheap base58+length check for a Solana pubkey string. Used by every
 *  route that takes a PDA or wallet in the URL so we reject bad input at
 *  the edge rather than constructing an invalid PublicKey mid-handler. */
export function isValidPublicKey(key: string): boolean {
  try { new PublicKey(key); return true; } catch { return false; }
}

/** Is this any Solana on-chain id — a 32-byte pubkey/PDA OR a 64-byte tx
 *  signature? The chain resolver needs both: /user|/table take pubkeys (32B),
 *  /data|/meta|/img take signatures (64B). `isValidPublicKey` only accepts 32B,
 *  so it would misclassify an 88-char signature as non-Solana. Byte-length
 *  (32/64) is far stricter than a charset check, so an EVM dbRootId that happens
 *  to be base58 won't collide unless it decodes to exactly 32 or 64 bytes. */
export function isSolanaId(s: string): boolean {
  if (typeof s !== "string" || s.startsWith("0x")) return false;
  try {
    const len = bs58.decode(s).length;
    return len === 32 || len === 64;
  } catch {
    return false;
  }
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
