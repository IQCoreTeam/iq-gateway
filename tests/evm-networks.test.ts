import { describe, test, expect } from "bun:test";
import { NETWORKS, isNetworkMode } from "../src/chain/evm/networks";

describe("networks", () => {
  test("registry has sepolia + monad + monadTestnet + robinhood with correct chain IDs", () => {
    expect(NETWORKS.sepolia.chainId).toBe(11155111);
    expect(NETWORKS.monad.chainId).toBe(143);
    expect(NETWORKS.monadTestnet.chainId).toBe(10143);
    expect(NETWORKS.robinhood.chainId).toBe(4663);
  });

  test("each network has a contract address and currency", () => {
    for (const k of ["sepolia", "monad", "monadTestnet", "robinhood"] as const) {
      expect(NETWORKS[k].contractAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(NETWORKS[k].currency.length).toBeGreaterThan(0);
    }
  });

  test("isNetworkMode rejects unknown strings", () => {
    expect(isNetworkMode("sepolia")).toBe(true);
    expect(isNetworkMode("ethereum")).toBe(false);
    expect(isNetworkMode(undefined)).toBe(false);
  });
});
