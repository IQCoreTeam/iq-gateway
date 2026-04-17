import { Hono } from "hono";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, TokenAccountNotFoundError } from "@solana/spl-token";
import { getTableMetaCached } from "../chain";
import { MemoryCache } from "../cache";
import { isValidPublicKey } from "../utils";

export const gateRouter = new Hono();

const MIN_SOL_FOR_POST = 0.005;
const GATE_CHECK_TTL = 30_000; // 30s — token balances can change quickly enough

const gateRpc = new Connection(
  process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
);
const gateCache = new MemoryCache<string>(2000);

// GET /gate/:tablePda/check/:wallet
// Returns the wallet's SOL balance, token balance for the gate mint (if any),
// and whether the wallet meets the table's gate config. Saves iq-chan the
// two client-side RPC round-trips (getBalance + getAccount).
gateRouter.get("/:tablePda/check/:wallet", async (c) => {
  const tablePda = c.req.param("tablePda");
  const wallet = c.req.param("wallet");
  if (!isValidPublicKey(tablePda) || !isValidPublicKey(wallet)) {
    return c.json({ error: "invalid PDA or wallet" }, 400);
  }

  const cacheKey = `${tablePda}:${wallet}`;
  const cached = gateCache.get(cacheKey);
  if (cached) return c.json({ ...JSON.parse(cached), cached: true });

  try {
    const meta = await getTableMetaCached(tablePda);
    if (!meta) return c.json({ error: "table not found" }, 404);

    const walletKey = new PublicKey(wallet);
    const lamports = await gateRpc.getBalance(walletKey);
    const sol = lamports / LAMPORTS_PER_SOL;
    const meetsSol = sol >= MIN_SOL_FOR_POST;

    let tokenBalance = 0;
    let meetsToken = true;
    if (meta.gate) {
      try {
        const ata = await getAssociatedTokenAddress(new PublicKey(meta.gate.mint), walletKey);
        const account = await getAccount(gateRpc, ata);
        tokenBalance = Number(account.amount);
      } catch (err) {
        // No ATA = zero balance (not an error from the user's perspective)
        if (!(err instanceof TokenAccountNotFoundError)) throw err;
      }
      meetsToken = tokenBalance >= meta.gate.amount;
    }

    const body = {
      tablePda,
      wallet,
      sol,
      gate: meta.gate,
      tokenBalance,
      meetsGate: meetsSol && meetsToken,
      minSol: MIN_SOL_FOR_POST,
    };
    gateCache.set(cacheKey, JSON.stringify(body), GATE_CHECK_TTL);
    return c.json({ ...body, cached: false });
  } catch (e) {
    console.error(`[gate] check failed for ${tablePda}/${wallet}:`, e instanceof Error ? e.message : e);
    return c.json({ error: "gate check failed" }, 500);
  }
});
