// ENS resolver — built on ethers' provider.resolveName / .lookupAddress.
// Cached 30 min per (name|address). ENS only resolves on Ethereum MAINNET, so
// this uses a dedicated mainnet provider independent of the active gateway
// network. A Sepolia-only deployment (no mainnet RPC) therefore can't resolve
// real ENS names — /ens stays mounted and 200s, but returns null until a
// working mainnet RPC is configured. This is a config gap, not a code path:
// set ENS_RPC_ENDPOINT to a live mainnet RPC in production.
//
// NOTE: the default below (eth.llamarpc.com) is unreliable — observed returning
// HTTP 526 in prod, which is why live `/ens/<name>` came back null. Verified
// working alternative: https://ethereum-rpc.publicnode.com (resolves
// vitalik.eth → 0xd8dA...6045). cloudflare-eth / ankr were flaky in testing.
// So: ENS is effectively a no-op on the current deployment until ENS_RPC_ENDPOINT
// is pointed at a stable mainnet RPC.

import { JsonRpcProvider, isAddress } from "ethers";
import { MemoryCache, getDiskCache, setDiskCache, deduped } from "../../cache";

const ENS_TTL = 30 * 60 * 1000;
const ENS_RPC =
  process.env.ENS_RPC_ENDPOINT ||
  // Fallback mainnet RPC. Unstable (526s seen in prod) — set ENS_RPC_ENDPOINT
  // to a reliable mainnet endpoint for ENS to actually work.
  "https://eth.llamarpc.com";

const ensProvider = new JsonRpcProvider(ENS_RPC);
export const ensCache = new MemoryCache<string>(1000);
export const ensInflight = new Map<string, Promise<unknown>>();

export async function resolveEns(name: string): Promise<string | null> {
  const lower = name.toLowerCase();
  const cached = ensCache.get(`fwd:${lower}`);
  if (cached !== null) return cached || null;

  const disk = await getDiskCache("ens", `fwd:${lower}`);
  if (disk) {
    const v = disk.toString("utf8");
    ensCache.set(`fwd:${lower}`, v, ENS_TTL);
    return v || null;
  }

  return deduped(ensInflight, `fwd:${lower}`, async () => {
    try {
      const addr = await ensProvider.resolveName(lower);
      const v = addr ?? "";
      ensCache.set(`fwd:${lower}`, v, ENS_TTL);
      setDiskCache("ens", `fwd:${lower}`, v).catch(() => {});
      return v || null;
    } catch (e) {
      console.warn("[ens] resolve failed:", e instanceof Error ? e.message : e);
      return null;
    }
  });
}

export async function reverseEns(address: string): Promise<string | null> {
  if (!isAddress(address)) return null;
  const lower = address.toLowerCase();
  const cached = ensCache.get(`rev:${lower}`);
  if (cached !== null) return cached || null;

  const disk = await getDiskCache("ens", `rev:${lower}`);
  if (disk) {
    const v = disk.toString("utf8");
    ensCache.set(`rev:${lower}`, v, ENS_TTL);
    return v || null;
  }

  return deduped(ensInflight, `rev:${lower}`, async () => {
    try {
      const name = await ensProvider.lookupAddress(lower);
      const v = name ?? "";
      ensCache.set(`rev:${lower}`, v, ENS_TTL);
      setDiskCache("ens", `rev:${lower}`, v).catch(() => {});
      return v || null;
    } catch (e) {
      console.warn("[ens] reverse failed:", e instanceof Error ? e.message : e);
      return null;
    }
  });
}
