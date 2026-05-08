// Unit tests for the parsing logic inside chain/sns.ts. The full resolver
// requires a live Solana RPC + on-chain records, so we test that path via
// integration (curl /sns/nubs in CI). These tests cover the deterministic
// pure-function parts: regex matching + content extraction from a mock
// V2 record buffer.

import { describe, expect, test } from "bun:test";

// Re-implement the regex constants here so we can validate them in
// isolation without importing the resolver (which boots a Connection).
const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{86,90}$/;
const SITE_PATH_RE = /\/site\/([1-9A-HJ-NP-Za-km-z]{86,90})(\/[^\s?#]*)?/;

const NUBS_SIG = "4Zj4SAMmYvUxw53L3ygP7Htwv8MjBKQrbz3CxVV6nNQpD236iaABsptWHf7LgzJVwXmk3W6LQLJjKa3cPfqbuSty";

describe("TX_SIG_RE", () => {
  test("matches 88-char base58 sig", () => {
    expect(TX_SIG_RE.test(NUBS_SIG)).toBe(true);
  });
  test("rejects too short", () => {
    expect(TX_SIG_RE.test(NUBS_SIG.slice(0, 80))).toBe(false);
  });
  test("rejects too long", () => {
    expect(TX_SIG_RE.test(NUBS_SIG + "ABCDEF")).toBe(false);
  });
  test("rejects non-base58 characters", () => {
    expect(TX_SIG_RE.test("0".repeat(88))).toBe(false); // 0 is excluded from base58
    expect(TX_SIG_RE.test("O".repeat(88))).toBe(false); // O is excluded
    expect(TX_SIG_RE.test("I".repeat(88))).toBe(false); // I is excluded
    expect(TX_SIG_RE.test("l".repeat(88))).toBe(false); // l is excluded
  });
});

describe("SITE_PATH_RE", () => {
  test("captures sig from /site/<sig>/", () => {
    const m = `https://gateway.iqlabs.dev/site/${NUBS_SIG}/`.match(SITE_PATH_RE);
    expect(m?.[1]).toBe(NUBS_SIG);
    expect(m?.[2]).toBe("/");
  });
  test("captures sig + file path", () => {
    const m = `https://gateway.iqlabs.dev/site/${NUBS_SIG}/gameboy.html`.match(SITE_PATH_RE);
    expect(m?.[1]).toBe(NUBS_SIG);
    expect(m?.[2]).toBe("/gameboy.html");
  });
  test("captures sig + nested path", () => {
    const m = `https://gateway.iqlabs.dev/site/${NUBS_SIG}/assets/style.css`.match(SITE_PATH_RE);
    expect(m?.[1]).toBe(NUBS_SIG);
    expect(m?.[2]).toBe("/assets/style.css");
  });
  test("strips query/fragment from path", () => {
    const m = `https://gateway.iqlabs.dev/site/${NUBS_SIG}/index.html?x=1#top`.match(SITE_PATH_RE);
    expect(m?.[1]).toBe(NUBS_SIG);
    expect(m?.[2]).toBe("/index.html");
  });
  test("matches regardless of host (multi-gateway)", () => {
    const m = `https://gateway.solanainternet.com/site/${NUBS_SIG}/gameboy.html`.match(SITE_PATH_RE);
    expect(m?.[1]).toBe(NUBS_SIG);
  });
  test("no match if /site/ is missing or sig is malformed", () => {
    expect(`https://example.com/${NUBS_SIG}/file`.match(SITE_PATH_RE)).toBeNull();
    expect(`https://example.com/site/short/file`.match(SITE_PATH_RE)).toBeNull();
  });
});

describe("V2 contentLength slicing (the SDK-bug-workaround)", () => {
  // Simulate the V2 record account data layout:
  //   [arbitrary header bytes][content of length contentLength]
  // The resolver slices the LAST contentLength bytes, ignoring the header.
  test("slices the last N bytes correctly", () => {
    const url = `https://gateway.iqlabs.dev/site/${NUBS_SIG}/gameboy.html`;
    const headerNoise = Buffer.from([0x24, 0x23, 0x17, 0x90, 0xfa, 0x7b, 0xa4, 0x49]);
    const data = Buffer.concat([headerNoise, Buffer.from(url, "utf-8")]);
    const cl = url.length;
    const sliced = data.slice(data.length - cl).toString("utf-8");
    expect(sliced).toBe(url);
  });
  test("regex still matches the sliced URL", () => {
    const url = `https://gateway.iqlabs.dev/site/${NUBS_SIG}/gameboy.html`;
    const m = url.match(SITE_PATH_RE);
    expect(m?.[1]).toBe(NUBS_SIG);
  });
});
