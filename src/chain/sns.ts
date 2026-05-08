// SNS domain → IQ manifest sig resolver.
// Reads V2 records on a .sol domain; if a record looks like a Solana tx
// signature (or wraps one inside a /site/<sig>/ URL), returns the sig so
// the gateway can serve the matching manifest.

import { Connection } from "@solana/web3.js";
import { Record, getMultipleRecordsV2 } from "@bonfida/spl-name-service";
import { HELIUS_RPC } from "./helius";
import { MemoryCache, getDiskCache, setDiskCache, deduped } from "../cache";

const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;
const SITE_PATH_RE = /\/site\/([1-9A-HJ-NP-Za-km-z]{86,90})(\/[^\s?#]*)?/;
const SNS_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_MARKER = "__none__";

const conn = new Connection(
  HELIUS_RPC || process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com"
);
export const snsCache = new MemoryCache<string>(500);
export const snsInflight = new Map<string, Promise<string>>();

export async function resolveDomainToSig(domain: string): Promise<string | null> {
  const key = domain.toLowerCase();

  const mem = snsCache.get(key);
  if (mem !== null) return mem === NEGATIVE_MARKER ? null : mem;

  const disk = await getDiskCache("sns", key);
  if (disk) {
    const v = disk.toString();
    snsCache.set(key, v, SNS_TTL_MS);
    return v === NEGATIVE_MARKER ? null : v;
  }

  // Dedup concurrent cold-cache requests for the same domain so we only hit
  // Solana RPC once even when N parallel requests arrive together.
  const stored = await deduped(snsInflight, key, async () => {
    let found: string | null = null;
    try {
      const probe = [Record.Url, Record.TXT] as const;
      const recs = await getMultipleRecordsV2(conn, key, [...probe]);
      for (const r of recs) {
        // SDK's deserializedContent is unreliable (truncates URL); read content
        // directly from the raw account data: V2 record layout is
        // [header][content of length header.contentLength].
        const data = r?.retrievedRecord?.data;
        const cl = r?.retrievedRecord?.header?.contentLength;
        if (!data || typeof cl !== "number" || cl <= 0 || cl > data.length) continue;
        const buf = Buffer.from(data);
        const value = buf.slice(buf.length - cl).toString("utf-8").trim();
        if (!value) continue;
        if (TX_SIG_RE.test(value)) { found = value; break; }
        const m = value.match(SITE_PATH_RE);
        if (m) {
          const tail = m[2] && m[2] !== "/" ? m[2] : "";
          found = m[1] + tail;
          break;
        }
      }
    } catch {
      // Domain doesn't exist or RPC errored — treat as miss and cache it so
      // junk lookups don't keep hitting Solana.
    }
    return found ?? NEGATIVE_MARKER;
  });

  snsCache.set(key, stored, SNS_TTL_MS);
  await setDiskCache("sns", key, Buffer.from(stored));
  return stored === NEGATIVE_MARKER ? null : stored;
}
