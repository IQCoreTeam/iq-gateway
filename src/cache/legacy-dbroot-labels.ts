// =============================================================================
// LEGACY ONLY — recover human-readable labels for DbRoots created before the
// SDK's `table_hint` upgrade (2026-04-06, commit 27479ee in iqlabs-solana-sdk).
//
// Those old DbRoots stored their `id` as the *hashed* seed bytes, not the raw
// utf-8 label. On read, getProgramAccounts decoding gives us a 32-byte blob
// and we can't recover the original string from the hash — it's one-way.
// But the set of legacy ids is **bounded**: only DbRoots that already exist on
// chain are affected. New DbRoots (post-2026-04-06) store raw bytes and don't
// need any of this.
//
// So we keep a small dictionary of known legacy dApp ids, hash each candidate
// at import time with **both** keccak256 (official SDK) and sha256 (used by
// some older external writers like clawbal-plugin), and accept whichever
// matches the on-chain idHex.
//
// This is ugly. We know. It exists because chain history exists. If we ever
// drop legacy DbRoots from the ecosystem this whole file goes away — nothing
// in the post-table_hint world hits it.
// =============================================================================

import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";

// LEGACY: bounded list of legacy dApp ids whose DbRoots predate the
// table_hint upgrade. Adding a new entry here only makes sense if the dApp
// was created before 2026-04-06 and its DbRoot id field is a 32-byte hash.
const LEGACY_IDS = [
  "iqchan",
  "iq-git-v1",
  "iqpages-root",
  "clawbal",
  "clawbal-chat",
  "clawbal-root",
  "clawbal-iqlabs",
];

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// LEGACY: import-time rainbow table. ~14 hashes (7 ids × 2 algorithms) so the
// cost is trivial; the Map.get on lookup is O(1).
const LABEL_BY_HEX: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const id of LEGACY_IDS) {
    const utf8 = new TextEncoder().encode(id);
    m.set(toHex(keccak_256(utf8)), id);
    m.set(toHex(sha256(utf8)), id);
  }
  return m;
})();

/** LEGACY: recover a DbRoot label from its 32-byte hashed id. Returns the
 *  raw utf-8 id when callers already have it; otherwise tries the legacy
 *  dictionary. Returns null when neither path resolves. */
export function recoverLegacyDbRootLabel(
  rawId: string | null,
  idHex: string,
): string | null {
  if (rawId) return rawId;
  return LABEL_BY_HEX.get(idHex.toLowerCase()) ?? null;
}
