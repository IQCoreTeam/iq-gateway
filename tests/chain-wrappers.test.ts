import { afterEach, describe, expect, test } from "bun:test";
import { buildWrappers } from "../src/chain/wrappers";

// buildWrappers reads process.env.IQ_CHAIN at call time; restore it after each case.
const original = process.env.IQ_CHAIN;
afterEach(() => {
  if (original === undefined) delete process.env.IQ_CHAIN;
  else process.env.IQ_CHAIN = original;
});

describe("buildWrappers — IQ_CHAIN mode selection", () => {
  test("unset serves solana + at least one evm network", () => {
    delete process.env.IQ_CHAIN;
    const keys = Object.keys(buildWrappers());
    expect(keys).toContain("solana");
    expect(keys.length).toBeGreaterThan(1);
  });

  test("IQ_CHAIN=multi is an alias for unset (not an empty map)", () => {
    delete process.env.IQ_CHAIN;
    const unset = Object.keys(buildWrappers()).sort();
    process.env.IQ_CHAIN = "multi";
    const multi = Object.keys(buildWrappers()).sort();
    expect(multi).toEqual(unset);
    expect(multi).toContain("solana");
    expect(multi.length).toBeGreaterThan(1);
  });

  test("IQ_CHAIN=solana locks to solana only", () => {
    process.env.IQ_CHAIN = "solana";
    expect(Object.keys(buildWrappers())).toEqual(["solana"]);
  });

  test("IQ_CHAIN=evm locks out solana", () => {
    process.env.IQ_CHAIN = "evm";
    const keys = Object.keys(buildWrappers());
    expect(keys).not.toContain("solana");
    expect(keys.length).toBeGreaterThan(0);
  });
});
