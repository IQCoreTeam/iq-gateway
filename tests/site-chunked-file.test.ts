import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { SiteChunkStore, parseChunkedSiteFile } from "../src/site-chunked-file";
import { parseManifest, resolveFile } from "../src/routes/site";
import { serveByteSource } from "../src/http-byte-source";
import { VerifiedObjectDiskCache } from "../src/cache/verified-objects";

const sign = (id: number) => bs58.encode(Buffer.alloc(64, id));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(disk?: VerifiedObjectDiskCache) {
  const objects = new Map<string, Buffer>();
  function store(value: Buffer, index: number) {
    const id = sign(index);
    objects.set(id, value);
    return { id, sha256: sha256(value) };
  }
  const chunks = Array.from({ length: 130 }, (_, index) => store(Buffer.alloc(index === 129 ? 1 : 4, index), index + 1));
  const left = store(Buffer.from(JSON.stringify(chunks.slice(0, 128))), 180);
  const right = store(Buffer.from(JSON.stringify(chunks.slice(128))), 181);
  const index = store(Buffer.from(JSON.stringify([left, right])), 182);
  const file = parseChunkedSiteFile({ version: 1, bytes: 517, chunkBytes: 4, index })!;
  const calls: string[] = [];
  const reader = new SiteChunkStore(async id => {
    calls.push(id);
    return { data: objects.get(id)?.toString("base64") ?? null };
  }, disk);
  return { objects, file, calls, reader };
}

test("ordinary and chunked paths can coexist in a site manifest", () => {
  const { file } = fixture();
  const manifest = parseManifest({
    index: { path: "index.html" },
    paths: {
      "index.html": { id: sign(30) },
      "nested/file.bin": { chunked: file },
      "invalid.bin": { chunked: { ...file, chunkBytes: 0 } },
    },
  });
  expect(resolveFile(manifest, "/")).toBe(sign(30));
  expect(manifest.chunkedFiles?.["nested/file.bin"]).toEqual(file);
  expect(manifest.chunkedFiles?.["invalid.bin"]).toBeUndefined();
  expect(parseManifest({ paths: { "index.html": { id: sign(30) } } })).toEqual({
    indexPath: "index.html", files: { "index.html": sign(30) },
  });
});

test("a fresh reader rebuilds a range from persisted pages and chunks without RPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iq-site-restart-"));
  try {
    const { file, reader } = fixture(new VerifiedObjectDiskCache(dir, 1024 * 1024));
    const before = reader.source(file);
    await before.read(508, 512);
    await before.read(512, 516);
    const after = new SiteChunkStore(async () => { throw new Error("unexpected RPC"); },
      new VerifiedObjectDiskCache(dir, 1024 * 1024)).source(file);
    const response = await serveByteSource(after, { range: "bytes=510-514", contentType: "application/octet-stream" });
    expect(response.status).toBe(206);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([127, 127, 128, 128, 128]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reads a range spanning two cold index pages and reuses verified objects", async () => {
  const { file, calls, reader } = fixture();
  const source = reader.source(file);
  const read = () => serveByteSource(source, { range: "bytes=510-514", contentType: "application/octet-stream" });
  const [a, b] = await Promise.all([read(), read()]);
  for (const response of [a, b]) {
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 510-514/517");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([127, 127, 128, 128, 128]);
  }
  expect(calls).toEqual([182, 180, 128, 181, 129].map(sign));
  expect(await (await read()).bytes()).toHaveLength(5);
  expect(calls).toHaveLength(5);
});

test("reuses cached Code-In data and rereads only when its hash differs", async () => {
  const { file, objects } = fixture();
  const calls: string[] = [];
  const data = (id: string) => objects.get(id)?.toString("base64") ?? null;
  const reader = new SiteChunkStore(async id => {
    calls.push(id);
    return { data: data(id) };
  }, undefined, async id => id === sign(129) ? Buffer.from("stale").toString("base64") : data(id));
  const source = reader.source(file);
  expect(await source.read(508, 512)).toEqual(Buffer.alloc(4, 127));
  expect(calls).toEqual([]);
  expect(await source.read(512, 516)).toEqual(Buffer.alloc(4, 128));
  expect(calls).toEqual([sign(129)]);
});

test("rejects changed chunks, changed index nodes, and an incorrect final length", async () => {
  const { file, objects, reader } = fixture();
  objects.set(sign(180), Buffer.from("[]"));
  await expect(reader.source(file).read(0, 4)).rejects.toThrow("failed verification");
  objects.set(sign(130), Buffer.from([1]));
  await expect(reader.source(file).read(516, 517)).rejects.toThrow("failed verification");

  const another = fixture();
  await expect(another.reader.source({ ...another.file, bytes: 518 }).read(516, 518))
    .rejects.toThrow("Invalid chunk length");
});
