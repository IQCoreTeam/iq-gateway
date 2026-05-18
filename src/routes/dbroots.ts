// /dbroots — discover every DbRoot on iqlabs in one call.
//
// Uses getProgramAccounts with a memcmp filter on the Anchor DbRoot
// discriminator so only DbRoot accounts come back (a small set: one per dApp),
// not the millions of other PDAs the program owns.
//
// Cached 30 min. DbRoots are near-static (new dApp launch or a table
// registration is the only thing that mutates them), so a long TTL is fine.

import { Hono } from "hono";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { contract } from "@iqlabs-official/solana-sdk";
import { MemoryCache } from "../cache";

export const dbrootsRouter = new Hono();

const PROGRAM_ID = new PublicKey(contract.DEFAULT_ANCHOR_PROGRAM_ID);
const accountCoder = new BorshAccountsCoder(contract.IQ_IDL);
// IDL-derived 8-byte tag every DbRoot account stores at offset 0. Using the
// coder (not a hardcoded array) keeps this resilient if the program is ever
// redeployed under a different program/account name.
const DBROOT_DISCRIMINATOR = accountCoder.accountDiscriminator("DbRoot");

const rpc = new Connection(
  process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
);

interface DbRootSummary {
  pda: string;
  /** utf-8 view of db_root.id. Many dApps store a human label here
   *  ("iqchan", "iq-git-v1", "solchat-root", ...) but some store a raw hashed
   *  seed instead, in which case this string contains non-printable bytes. */
  id: string;
  /** Hex of the raw id bytes — stable across all dApps, useful when `id`
   *  is binary. */
  idHex: string;
  /** True when `id` decodes cleanly to printable ASCII/UTF-8. Lets clients
   *  decide whether to display `id` or `idHex`. */
  idIsPrintable: boolean;
  creator: string | null;
  tableSeedsCount: number;
  globalTableSeedsCount: number;
}

interface DbRootsPayload {
  dbroots: DbRootSummary[];
  fetchedAt: number;
  count: number;
}

const cache = new MemoryCache<string>(1);
const TTL_MS = 30 * 60 * 1000;
const CACHE_KEY = "dbroots:all";
let inflight: Promise<DbRootsPayload> | null = null;

function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (Array.isArray(v)) return Buffer.from(v as number[]);
  if (v && typeof v === "object" && Array.isArray((v as { data?: number[] }).data)) {
    return Buffer.from((v as { data: number[] }).data);
  }
  return Buffer.alloc(0);
}

// Treat tab/newline/space + printable ASCII as "displayable". Most dApps use
// kebab-case ASCII for their db_root id; raw 32-byte seeds will fail this.
function isPrintableUtf8(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

function decodeDbRoot(pda: PublicKey, raw: Buffer): DbRootSummary {
  // BorshAccountsCoder.decode strips the 8-byte discriminator before parsing.
  const decoded = accountCoder.decode("DbRoot", raw) as Record<string, unknown>;
  const tableSeeds = (decoded.table_seeds ?? decoded.tableSeeds ?? []) as unknown[];
  const globalTableSeeds = (decoded.global_table_seeds ?? decoded.globalTableSeeds ?? []) as unknown[];
  const creator = decoded.creator as PublicKey | undefined;

  const idBuf = toBuffer(decoded.id);
  const printable = isPrintableUtf8(idBuf);
  return {
    pda: pda.toBase58(),
    id: printable ? idBuf.toString("utf8") : "",
    idHex: idBuf.toString("hex"),
    idIsPrintable: printable,
    creator: creator ? new PublicKey(creator).toBase58() : null,
    tableSeedsCount: tableSeeds.length,
    globalTableSeedsCount: globalTableSeeds.length,
  };
}

async function fetchAllDbRoots(): Promise<DbRootsPayload> {
  const accounts = await rpc.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: bs58.encode(DBROOT_DISCRIMINATOR),
        },
      },
    ],
  });

  const dbroots: DbRootSummary[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      dbroots.push(decodeDbRoot(pubkey, account.data));
    } catch (e) {
      console.warn(`[dbroots] failed to decode ${pubkey.toBase58()}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Sort for stable output across calls.
  dbroots.sort((a, b) => a.id.localeCompare(b.id) || a.pda.localeCompare(b.pda));

  return {
    dbroots,
    fetchedAt: Date.now(),
    count: dbroots.length,
  };
}

dbrootsRouter.get("/", async (c) => {
  const cached = cache.get(CACHE_KEY);
  if (cached) return c.json(JSON.parse(cached));

  // Dedup concurrent cold-cache requests so we only hit RPC once.
  if (!inflight) {
    inflight = (async () => {
      try {
        return await fetchAllDbRoots();
      } finally {
        inflight = null;
      }
    })();
  }

  try {
    const payload = await inflight;
    cache.set(CACHE_KEY, JSON.stringify(payload), TTL_MS);
    return c.json(payload);
  } catch (e) {
    console.error("[dbroots] failed:", e instanceof Error ? e.message : e);
    return c.json({ error: "failed to read DbRoots" }, 500);
  }
});
