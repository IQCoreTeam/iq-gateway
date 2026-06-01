import { describe, test, expect } from "bun:test";
import { isTxHash, isEvmAddress } from "../src/utils";

describe("utils", () => {
  test("isTxHash accepts a well-formed 0x-prefixed 64-hex string", () => {
    expect(isTxHash("0x" + "a".repeat(64))).toBe(true);
    expect(isTxHash("0x" + "A".repeat(64))).toBe(true);
    expect(isTxHash("0x" + "9".repeat(64))).toBe(true);
  });

  test("isTxHash rejects malformed input", () => {
    expect(isTxHash("0x" + "a".repeat(63))).toBe(false);
    expect(isTxHash("a".repeat(64))).toBe(false);
    expect(isTxHash("")).toBe(false);
    expect(isTxHash("0x" + "z".repeat(64))).toBe(false);
  });

  test("isEvmAddress validates checksum + length", () => {
    expect(isEvmAddress("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isEvmAddress("d8da6bf26964aF9D7eEd9e03E53415D37aA96045")).toBe(false);
    expect(isEvmAddress("0xnotanaddress")).toBe(false);
  });
});
