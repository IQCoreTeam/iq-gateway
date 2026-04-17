import { PublicKey } from "@solana/web3.js";

/** Cheap base58+length check for a Solana pubkey string. Used by every
 *  route that takes a PDA or wallet in the URL so we reject bad input at
 *  the edge rather than constructing an invalid PublicKey mid-handler. */
export function isValidPublicKey(key: string): boolean {
  try { new PublicKey(key); return true; } catch { return false; }
}
