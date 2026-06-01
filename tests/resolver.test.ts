import { describe, expect, test } from "bun:test";
import { resolveChain, extractId, EVM_DEFAULT_NETWORK } from "../src/resolver";

// A real Solana pubkey (base58, 32 bytes) and a real EVM txHash / address.
const SOL_PUBKEY = "11111111111111111111111111111111";
const SOL_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"; // 88-char base58
const EVM_TX = "0xfcfcccca3f55ad2c1b02c23f233d42df01b667de6c8d85caefe0573d17c3d483";
const EVM_ADDR = "0x76ce2c5F3C50e9074C4342BE37d7a90CAC30829c";
const EVM_DBROOT = "iq-eth-gateway-test-navv17"; // arbitrary, hyphenated → not base58

describe("resolveChain — auto-detect by id shape", () => {
  test("base58 pubkey → solana", () => {
    expect(resolveChain(SOL_PUBKEY)).toEqual({ chain: "solana", network: "solana" });
  });
  test("base58 signature → solana", () => {
    expect(resolveChain(SOL_SIG)).toEqual({ chain: "solana", network: "solana" });
  });
  test("0x txHash → evm default (sepolia)", () => {
    expect(resolveChain(EVM_TX)).toEqual({ chain: "evm", network: EVM_DEFAULT_NETWORK });
  });
  test("0x address → evm default", () => {
    expect(resolveChain(EVM_ADDR)).toEqual({ chain: "evm", network: EVM_DEFAULT_NETWORK });
  });
  test("arbitrary dbRootId (non-base58) → evm default", () => {
    expect(resolveChain(EVM_DBROOT)).toEqual({ chain: "evm", network: EVM_DEFAULT_NETWORK });
  });
});

describe("resolveChain — ?network override", () => {
  test("?network=monad → evm monad regardless of id shape", () => {
    expect(resolveChain(EVM_TX, "monad")).toEqual({ chain: "evm", network: "monad" });
  });
  test("?network=monadTestnet → evm monadTestnet", () => {
    expect(resolveChain(EVM_DBROOT, "monadTestnet")).toEqual({ chain: "evm", network: "monadTestnet" });
  });
  test("?network=sepolia → evm sepolia", () => {
    expect(resolveChain(EVM_TX, "sepolia")).toEqual({ chain: "evm", network: "sepolia" });
  });
  test("?network=solana forces solana even for a 0x id", () => {
    expect(resolveChain(EVM_TX, "solana")).toEqual({ chain: "solana", network: "solana" });
  });
  test("unknown ?network → 400 (never a silent wrong-chain)", () => {
    const r = resolveChain(EVM_TX, "ethereum");
    expect("error" in r && r.status).toBe(400);
  });
  test("?network override wins over a base58 id", () => {
    expect(resolveChain(SOL_PUBKEY, "monad")).toEqual({ chain: "evm", network: "monad" });
  });
});

describe("resolveChain — id-less routes", () => {
  test("no id, no param → a default chain (no throw)", () => {
    const r = resolveChain(undefined);
    expect("chain" in r).toBe(true);
  });
  test("no id but ?network=monad → evm monad", () => {
    expect(resolveChain(undefined, "monad")).toEqual({ chain: "evm", network: "monad" });
  });
});

describe("extractId — path → candidate id", () => {
  test("/data/{tx}", () => expect(extractId("/data/" + EVM_TX)).toBe(EVM_TX));
  test("/meta/{tx}.json strips extension", () => expect(extractId("/meta/" + EVM_TX + ".json")).toBe(EVM_TX));
  test("/img/{tx}.png strips extension", () => expect(extractId("/img/" + EVM_TX + ".png")).toBe(EVM_TX));
  test("/table/{dbRootId}/{table}/rows → dbRootId", () => expect(extractId("/table/" + EVM_DBROOT + "/posts/rows")).toBe(EVM_DBROOT));
  test("/user/{addr}/assets → addr", () => expect(extractId("/user/" + EVM_ADDR + "/assets")).toBe(EVM_ADDR));
  test("/health → undefined (id-less)", () => expect(extractId("/health")).toBeUndefined());
  test("/dbroots → undefined (id-less)", () => expect(extractId("/dbroots")).toBeUndefined());
  test("/ → undefined", () => expect(extractId("/")).toBeUndefined());
});
