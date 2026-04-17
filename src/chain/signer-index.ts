import { MemoryCache, getDiskCache, setDiskCache } from "../cache";

/**
 * Opportunistic signer → [txSignature, ...] index.
 *
 * Populated from formatRow whenever we decode a row that has a signer. The
 * index grows as the gateway serves traffic; it does not back-scan. So a
 * wallet with old posts that haven't been re-fetched since gateway start
 * will show up partial until those rows flow through again.
 *
 * Newest-first ordering is maintained by unshifting new sigs to the front
 * and deduping.
 */

const INDEX_TTL = 30 * 24 * 60 * 60 * 1000; // 30d — immutable tx history
const MAX_SIGS_PER_SIGNER = 2000;            // hard ceiling to bound memory

const signerCache = new MemoryCache<string>(5000);

/**
 * Records that `signer` authored `sig`. Safe to call repeatedly — dedupes and
 * trims to MAX_SIGS_PER_SIGNER. Disk write is fire-and-forget.
 */
export function recordSignerSig(signer: string, sig: string): void {
  const existing = signerCache.get(signer);
  const arr: string[] = existing ? JSON.parse(existing) : [];
  if (arr[0] === sig) return;            // hot path: already at front
  const without = arr.filter((s) => s !== sig);
  if (without.length >= MAX_SIGS_PER_SIGNER) without.length = MAX_SIGS_PER_SIGNER - 1;
  without.unshift(sig);
  const json = JSON.stringify(without);
  signerCache.set(signer, json, INDEX_TTL);
  setDiskCache("signer-index", signer, json).catch(() => {});
}

/**
 * Returns the known sigs for `signer`, newest-first. Loads from disk on miss.
 * Empty array if nothing recorded yet.
 */
export async function getSignerSigs(signer: string, limit: number): Promise<string[]> {
  const mem = signerCache.get(signer);
  if (mem) return JSON.parse(mem).slice(0, limit);
  const disk = await getDiskCache("signer-index", signer);
  if (disk) {
    const json = disk.toString("utf8");
    signerCache.set(signer, json, INDEX_TTL);
    return JSON.parse(json).slice(0, limit);
  }
  return [];
}
