// Alchemy helper — builds the Alchemy JSON-RPC URL when ALCHEMY_API_KEY is
// set, so reader.ts can construct a single provider. Also exposes a flag the
// rate limiter uses to loosen its bucket.

import { NetworkMode } from "./networks";

const ALCHEMY_HOSTS: Partial<Record<NetworkMode, string>> = {
  sepolia: "https://eth-sepolia.g.alchemy.com/v2",
  // Monad does not have a public Alchemy host yet; left intentionally empty.
};

export function isAlchemyEnabled(): boolean {
  return !!process.env.ALCHEMY_API_KEY;
}

export function alchemyRpcUrl(network: NetworkMode): string | null {
  if (!isAlchemyEnabled()) return null;
  const host = ALCHEMY_HOSTS[network];
  if (!host) return null;
  return `${host}/${process.env.ALCHEMY_API_KEY}`;
}
