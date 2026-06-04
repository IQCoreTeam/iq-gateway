// /gate/:dbRootId/:tableName/check/:wallet — server-side token-gate check.
// Replaces SPL ATA lookup with ERC-20 balanceOf (gateType=0/token) or
// ERC-721 balanceOf (gateType=1/collection).

import { Hono } from "hono";
import { Contract, isAddress, formatEther } from "ethers";
import { MemoryCache } from "../../cache";
import type { EvmEnv } from "../../chain/wrappers";

export const gateRouter = new Hono<EvmEnv>();

const MIN_NATIVE_FOR_POST = 0n; // EVM gas is paid per tx; no SOL-rent analogue. Leave 0 unless an op wants a floor.
const GATE_CHECK_TTL = 30_000;

const gateCache = new MemoryCache<string>(2000);

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

gateRouter.get("/:dbRootId/:tableName/check/:wallet", async (c) => {
  const dbRootId = c.req.param("dbRootId");
  const tableName = c.req.param("tableName");
  const wallet = c.req.param("wallet");
  if (!isAddress(wallet)) return c.json({ error: "invalid wallet" }, 400);
  const chain = c.get("chain");
  const network = c.get("network");

  const cacheKey = `${network}::${dbRootId}::${tableName}::${wallet.toLowerCase()}`;
  const cached = gateCache.get(cacheKey);
  if (cached) return c.json({ ...JSON.parse(cached), cached: true });

  try {
    const meta = await chain.getTableMetaCached(dbRootId, tableName);
    if (!meta) return c.json({ error: "table not found" }, 404);

    const provider = chain.getProvider();
    const wei = await provider.getBalance(wallet);
    const nativeBalance = Number(formatEther(wei));
    const minNative = Number(formatEther(MIN_NATIVE_FOR_POST));
    const meetsNative = wei >= MIN_NATIVE_FOR_POST;

    let tokenBalance = "0";
    let meetsToken = true;
    if (meta.gate) {
      try {
        const erc = new Contract(meta.gate.mint, ERC20_ABI, provider);
        const bal: bigint = await erc.balanceOf(wallet);
        tokenBalance = bal.toString();
        meetsToken = bal >= BigInt(meta.gate.amount);
      } catch (err) {
        // Token contract not deployed or wallet has no entry — both = zero.
        meetsToken = BigInt(meta.gate.amount) === 0n;
      }
    }

    const body = {
      dbRootId,
      tableName,
      wallet,
      nativeBalance,
      nativeSymbol: chain.config.currency,
      gate: meta.gate,
      tokenBalance,
      meetsGate: meetsNative && meetsToken,
      minNative,
    };
    gateCache.set(cacheKey, JSON.stringify(body), GATE_CHECK_TTL);
    return c.json({ ...body, cached: false });
  } catch (e) {
    console.error(`[gate] check failed for ${dbRootId}/${tableName}/${wallet}:`, e instanceof Error ? e.message : e);
    return c.json({ error: "gate check failed" }, 500);
  }
});
