import { Connection, PublicKey } from "@solana/web3.js";
import { reader as sdkReader } from "@iqlabs-official/solana-sdk";
import { MemoryCache } from "../cache";

const NULL_MINT = "11111111111111111111111111111111";
const META_TTL = 5 * 60 * 1000; // 5min — table metadata rarely changes

const metaRpc = new Connection(
  process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
);
const metaCache = new MemoryCache<string>(500);

/** Read and decode on-chain table metadata. Returns null if the account
 *  doesn't exist. Pure chain read, no cache — use `getTableMetaCached` in
 *  hot paths. */
export async function readTableMeta(
  conn: Connection,
  tablePda: string,
): Promise<{
  name: string;
  columns: string[];
  idCol: string;
  lastTimestamp: number;
  gate: { mint: string; amount: number; gateType: number } | null;
} | null> {
  // getAccountInfo failures (RPC trouble) propagate. A present account that
  // isn't a Table (e.g. someone probed a wallet address) fails to decode —
  // that's "not a table", returned as null so the caller can cache it instead
  // of re-hitting RPC on every probe.
  const info = await conn.getAccountInfo(new PublicKey(tablePda));
  if (!info) return null;
  let decoded;
  try {
    decoded = sdkReader.decodeTableMeta(info.data);
  } catch {
    return null;
  }
  const mint = decoded.gate.mint.toBase58();
  return {
    name: decoded.name,
    columns: decoded.columns,
    idCol: decoded.idCol,
    lastTimestamp: decoded.lastTimestamp,
    gate: mint !== NULL_MINT
      ? { mint, amount: decoded.gate.amount.toNumber(), gateType: decoded.gate.gateType }
      : null,
  };
}

/** Cached wrapper around readTableMeta. Keyed on PDA only — the meta doesn't
 *  vary per wallet/client, so every caller for the same table within 5min
 *  shares one RPC. Used by /table/:pda/meta and /gate/:pda/check/:wallet. */
export async function getTableMetaCached(
  tablePda: string,
): Promise<Awaited<ReturnType<typeof readTableMeta>>> {
  const cached = metaCache.get(tablePda);
  if (cached !== null) return JSON.parse(cached);
  const meta = await readTableMeta(metaRpc, tablePda);
  // Cache the miss too (stored as "null") — callers probe arbitrary pubkeys
  // (e.g. a wallet) to ask "is this a table?", and a wallet decodes to null.
  // Without this, every such probe re-hits RPC.
  metaCache.set(tablePda, JSON.stringify(meta), META_TTL);
  return meta;
}
