// SNS domain → IQ manifest sig resolver.
// Reads V2 records on a .sol domain; if a record looks like a Solana tx
// signature (or wraps one inside a /site/<sig>/ URL), returns the sig so
// the gateway can serve the matching manifest.

import { Connection, PublicKey } from "@solana/web3.js";
import {
  Record,
  getMultipleRecordsV2,
  getRecordV2,
  getNameOwner,
  getDomainKeySync,
} from "@bonfida/spl-name-service";
import { HELIUS_RPC } from "./helius";
import { MemoryCache, getDiskCache, setDiskCache, deduped } from "../../cache";

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

// ── Generic cached domain lookup ─────────────────────────────────────────────
// owner and SOL record are near-static, so cache them a day. `fresh` skips the
// cache read (still writes the fresh value back). Same memory+disk+negative+
// dedup pattern as resolveDomainToSig, keyed per kind so they don't collide.

const DAY_MS = 24 * 60 * 60 * 1000;

async function cachedDomainLookup(
  kind: string,
  domain: string,
  fresh: boolean,
  fetcher: () => Promise<string | null>,
): Promise<string | null> {
  const key = `${kind}:${domain.toLowerCase()}`;

  if (!fresh) {
    const mem = snsCache.get(key);
    if (mem !== null) return mem === NEGATIVE_MARKER ? null : mem;
    const disk = await getDiskCache("sns", key);
    if (disk) {
      const v = disk.toString();
      snsCache.set(key, v, DAY_MS);
      return v === NEGATIVE_MARKER ? null : v;
    }
  }

  // The fetcher returns null for a genuine miss (domain/record doesn't exist)
  // and throws on RPC failure (429, timeout). Only cache the miss — a transient
  // RPC error must not get pinned for a day, so we let it propagate uncached.
  const stored = await deduped(snsInflight, key, async () => (await fetcher()) ?? NEGATIVE_MARKER);

  snsCache.set(key, stored, DAY_MS);
  await setDiskCache("sns", key, Buffer.from(stored));
  return stored === NEGATIVE_MARKER ? null : stored;
}

// A missing domain/record throws "account not found"; that's a real miss
// (cache it). Anything else (429, timeout) is transient — rethrow so it isn't
// pinned in the day-long cache.
function nullIfMissingElseThrow(e: unknown): null {
  if (e instanceof Error && /not found/i.test(e.message)) return null;
  throw e;
}

// The wallet that owns the domain (the registry owner). base58, or null.
export function resolveDomainOwner(domain: string, fresh = false): Promise<string | null> {
  return cachedDomainLookup("owner", domain, fresh, async () => {
    try {
      const { pubkey } = getDomainKeySync(domain);
      const { registry } = await getNameOwner(conn, pubkey);
      return registry.owner.toBase58();
    } catch (e) {
      return nullIfMissingElseThrow(e);
    }
  });
}

// The SOL record value (what the owner pointed the domain at — a wallet or
// PDA, as base58). The SOL record stores raw 32 bytes, so we let the SDK
// deserialize it to base58 rather than utf-8-decoding (unlike the URL/TXT
// record, which is a string). null if unset. The browser classifies the value.
export function resolveDomainRecord(domain: string, fresh = false): Promise<string | null> {
  return cachedDomainLookup("record", domain, fresh, async () => {
    try {
      const res = await getRecordV2(conn, domain, Record.SOL, { deserialize: true });
      return res?.deserializedContent?.trim() || null;
    } catch (e) {
      return nullIfMissingElseThrow(e);
    }
  });
}
