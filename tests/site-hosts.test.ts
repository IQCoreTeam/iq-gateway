import { describe, expect, test } from "bun:test";
import {
  normalizeHost,
  isReservedGatewayPath,
  isSafePath,
  RESERVED_GATEWAY_PATHS,
} from "../src/site-hosts";

describe("normalizeHost", () => {
  test("lowercases", () => {
    expect(normalizeHost("Nubs.Sol.Site")).toBe("nubs.sol.site");
  });
  test("strips :port", () => {
    expect(normalizeHost("nubs.sol.site:8080")).toBe("nubs.sol.site");
  });
  test("trims whitespace", () => {
    expect(normalizeHost("  nubs.sol.site  ")).toBe("nubs.sol.site");
  });
  test("returns null for missing/blank", () => {
    expect(normalizeHost(null)).toBeNull();
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("   ")).toBeNull();
  });
});

describe("isReservedGatewayPath", () => {
  test("matches each reserved prefix exactly", () => {
    for (const r of RESERVED_GATEWAY_PATHS) {
      expect(isReservedGatewayPath(r)).toBe(true);
    }
  });
  test("matches reserved prefix as path root", () => {
    expect(isReservedGatewayPath("/site/abc")).toBe(true);
    expect(isReservedGatewayPath("/sns/nubs")).toBe(true);
    expect(isReservedGatewayPath("/health/check")).toBe(true);
  });
  test("rejects non-reserved paths", () => {
    expect(isReservedGatewayPath("/")).toBe(false);
    expect(isReservedGatewayPath("/index.html")).toBe(false);
    expect(isReservedGatewayPath("/sitething")).toBe(false); // not a prefix match
  });
});

describe("isSafePath", () => {
  test("accepts root and empty", () => {
    expect(isSafePath("")).toBe(true);
    expect(isSafePath("/")).toBe(true);
  });
  test("accepts normal paths", () => {
    expect(isSafePath("/index.html")).toBe(true);
    expect(isSafePath("/assets/style.css")).toBe(true);
    expect(isSafePath("/src/app.js")).toBe(true);
  });
  test("rejects ..", () => {
    expect(isSafePath("/../secret")).toBe(false);
    expect(isSafePath("/assets/../../secret")).toBe(false);
  });
  test("rejects backslashes", () => {
    expect(isSafePath("\\windows\\path")).toBe(false);
    expect(isSafePath("/foo\\bar")).toBe(false);
  });
  test("rejects scheme-relative URLs", () => {
    expect(isSafePath("//example.com/file")).toBe(false);
  });
  test("rejects absolute URLs", () => {
    expect(isSafePath("https://example.com/file")).toBe(false);
    expect(isSafePath("file:///etc/passwd")).toBe(false);
    expect(isSafePath("javascript:alert(1)")).toBe(false);
  });
});
