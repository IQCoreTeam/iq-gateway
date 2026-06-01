// /ens — ENS forward + reverse resolver. Replaces Solana SNS.

import { Hono } from "hono";
import { isAddress } from "ethers";
import { resolveEns, reverseEns } from "../../chain/evm/ens";

export const ensRouter = new Hono();

ensRouter.get("/:name", async (c) => {
  const name = c.req.param("name");
  if (!name) return c.json({ error: "invalid name" }, 400);

  // Reverse lookup if the segment is an address
  if (isAddress(name)) {
    const ensName = await reverseEns(name);
    return c.json({ address: name, name: ensName });
  }

  const address = await resolveEns(name);
  return c.json({ name, address });
});

ensRouter.get("/:addr/reverse", async (c) => {
  const addr = c.req.param("addr");
  if (!isAddress(addr)) return c.json({ error: "invalid address" }, 400);
  const name = await reverseEns(addr);
  return c.json({ address: addr, name });
});
