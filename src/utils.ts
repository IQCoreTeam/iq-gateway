import { PublicKey } from "@solana/web3.js";
import { isAddress } from "ethers";
import bs58 from "bs58";

/** Cheap base58+length check for a Solana pubkey string. Used by every
 *  route that takes a PDA or wallet in the URL so we reject bad input at
 *  the edge rather than constructing an invalid PublicKey mid-handler. */
export function isValidPublicKey(key: string): boolean {
  try { new PublicKey(key); return true; } catch { return false; }
}

function solanaIdBytes(value: unknown): number {
  if (typeof value !== "string" || value.length < 32 || value.length > 88) return 0;
  try { return bs58.decode(value).length; } catch { return 0; }
}

/** Is this any Solana on-chain id — a 32-byte pubkey/PDA OR a 64-byte tx
 *  signature? The chain resolver needs both: /user|/table take pubkeys (32B),
 *  /data|/meta|/img take signatures (64B). `isValidPublicKey` only accepts 32B,
 *  so it would misclassify an 88-char signature as non-Solana. Byte-length
 *  (32/64) is far stricter than a charset check, so an EVM dbRootId that happens
 *  to be base58 won't collide unless it decodes to exactly 32 or 64 bytes. */
export function isSolanaId(s: string): boolean {
  const length = solanaIdBytes(s);
  return length === 32 || length === 64;
}

export function isSolanaSignature(value: unknown): value is string {
  return solanaIdBytes(value) === 64;
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
