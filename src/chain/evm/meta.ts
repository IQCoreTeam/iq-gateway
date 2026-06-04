import { MemoryCache } from "../../cache";
import { fetchTableMeta as defaultFetchTableMeta } from "./reader";

const META_TTL = 5 * 60 * 1000;

export interface TableMeta {
  dbRootId: string;
  tableName: string;
  /** keccak256(tableName) — table's mapping key on chain. */
  seedHex: string;
  /** tx-chain tail; "0x0...0" / "Genesis" when empty. */
  txChainTail: string;
  /** Optional token/NFT gate. ERC-20 amount stored in wei. */
  gate: { mint: string; amount: string; gateType: number } | null;
  lastTimestamp: number;
}

function keyFor(dbRootId: string, tableName: string): string {
  return `${dbRootId}::${tableName}`;
}

function normalizeGate(raw: { mint?: string; amount?: bigint | string; gateType?: number } | null): TableMeta["gate"] {
  if (!raw) return null;
  const mint = (raw.mint ?? "").toString();
  if (!mint || /^0x0+$/.test(mint)) return null;
  return {
    mint,
    amount: (raw.amount ?? 0n).toString(),
    gateType: Number(raw.gateType ?? 0),
  };
}

type FetchTableMetaFn = (dbRootId: string, tableName: string) => Promise<any>;

/** Build a table-meta cache bound to one network's reader. Each per-network
 *  wrapper gets its own cache, so the same (dbRootId,tableName) on sepolia vs
 *  monad never share an entry. Errors are treated as "table not found" and
 *  cached as null so probing arbitrary names doesn't keep hitting RPC. */
export function createMetaCache(fetchTableMeta: FetchTableMetaFn) {
  const metaCache = new MemoryCache<string>(500);
  return async function getTableMetaCached(dbRootId: string, tableName: string): Promise<TableMeta | null> {
    const k = keyFor(dbRootId, tableName);
    const cached = metaCache.get(k);
    if (cached !== null) {
      const parsed = JSON.parse(cached);
      return parsed === null ? null : parsed;
    }
    try {
      const table = await fetchTableMeta(dbRootId, tableName);
      const meta: TableMeta = {
        dbRootId,
        tableName,
        seedHex: table.tableSeed ?? table.seedHex ?? "",
        txChainTail: table.txChainTail,
        gate: normalizeGate(table.gate ?? null),
        // Solidity Table struct doesn't carry a lastTimestamp directly; the SDK
        // exposes the tail tx hash. Using Date.now stamps freshness for the
        // background refresh gate — adequate since refresh is throttled.
        lastTimestamp: Date.now(),
      };
      metaCache.set(k, JSON.stringify(meta), META_TTL);
      return meta;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not found") || msg.includes("Table not found")) {
        metaCache.set(k, JSON.stringify(null), META_TTL);
        return null;
      }
      throw e;
    }
  };
}

// Back-compat module-level cache, bound to the default reader instance.
export const getTableMetaCached = createMetaCache(defaultFetchTableMeta);
