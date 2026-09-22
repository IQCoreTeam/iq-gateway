import { describe, expect, test } from "bun:test";
import { decodeAssetData } from "../src/chain/solana/reader";

const metadata = JSON.stringify({ filename: "iqgit-blob:iqpages.json", filetype: "application/octet-stream" });

describe("IQ Git blob decoding", () => {
  test("decodes short JSON and binary blobs without the legacy size threshold", () => {
    for (const original of [Buffer.from('{"entry":"index.html"}'), Buffer.from([0, 255, 1]), Buffer.alloc(0)]) {
      expect(decodeAssetData(original.toString("base64"), metadata)).toEqual(original);
    }
  });
  test("leaves unmarked short text unchanged", () => {
    expect(decodeAssetData("test").toString()).toBe("test");
    expect(decodeAssetData("test", "old metadata").toString()).toBe("test");
  });
  test("rejects malformed marked data instead of silently losing bytes", () => {
    expect(() => decodeAssetData("not base64!", metadata)).toThrow("invalid IQ Git blob encoding");
  });
  test("preserves legacy data URLs and long base64 assets", () => {
    const original = Buffer.from("long original asset ".repeat(20));
    expect(decodeAssetData(original.toString("base64"))).toEqual(original);
    expect(decodeAssetData("data:application/octet-stream;base64,AAE=")).toEqual(Buffer.from([0, 1]));
  });
});
