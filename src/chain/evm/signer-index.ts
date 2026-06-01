import { MemoryCache, getDiskCache, setDiskCache } from "../../cache";

/**
 * Opportunistic signer → [txHash, ...] index.
 * Populated from formatRow whenever we decode a row that has a signer (tx.from).
 * Grows as the gateway serves traffic; does not back-scan.
 */

const INDEX_TTL = 30 * 24 * 60 * 60 * 1000; // 30d — immutable tx history
const MAX_SIGS_PER_SIGNER = 2000;

const signerCache = new MemoryCache<string>(5000);

export function recordSignerSig(signer: string, txHash: string): void {
  const lower = signer.toLowerCase();
  const existing = signerCache.get(lower);
  const arr: string[] = existing ? JSON.parse(existing) : [];
  if (arr[0] === txHash) return;
  const without = arr.filter((s) => s !== txHash);
  if (without.length >= MAX_SIGS_PER_SIGNER) without.length = MAX_SIGS_PER_SIGNER - 1;
  without.unshift(txHash);
  const json = JSON.stringify(without);
  signerCache.set(lower, json, INDEX_TTL);
  setDiskCache("signer-index", lower, json).catch(() => {});
}

export async function getSignerSigs(signer: string, limit: number): Promise<string[]> {
  const lower = signer.toLowerCase();
  const mem = signerCache.get(lower);
  if (mem) return JSON.parse(mem).slice(0, limit);
  const disk = await getDiskCache("signer-index", lower);
  if (disk) {
    const json = disk.toString("utf8");
    signerCache.set(lower, json, INDEX_TTL);
    return JSON.parse(json).slice(0, limit);
  }
  return [];
}
