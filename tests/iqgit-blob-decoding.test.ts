import { describe, expect, test } from "bun:test";
// Route tests mock the reader globally; keep real decoder assertions isolated.
if (process.env.IQ_BLOB_TEST_ISOLATED !== "1") {
  test("IQ Git blob decoding (isolated)", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      env: { ...process.env, IQ_BLOB_TEST_ISOLATED: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) console.error(new TextDecoder().decode(result.stderr));
    expect(result.exitCode).toBe(0);
  });
} else {
const { decodeAssetData } = await import("../src/chain/solana/reader");

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

}
