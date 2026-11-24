import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerifiedObjectDiskCache } from "../src/cache/verified-objects";

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("keeps verified objects across restarts and evicts by shared byte budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iq-verified-cache-"));
  try {
    const cache = new VerifiedObjectDiskCache(dir, 8);
    const [a, b, c] = ["aaaa", "bbbb", "cccc"].map(value => Buffer.from(value));
    await cache.put("a", digest(a), a);
    await cache.put("b", digest(b), b);
    const restarted = new VerifiedObjectDiskCache(dir, 8);
    expect(await restarted.get("a", digest(a))).toEqual(a);
    await restarted.put("c", digest(c), c);
    expect(await restarted.get("a", digest(a))).toEqual(a);
    expect(await restarted.get("b", digest(b))).toBeUndefined();
    expect(await restarted.get("c", digest(c))).toEqual(c);
    const files = await readdir(dir);
    const sizes = await Promise.all(files.map(async file => (await stat(join(dir, file))).size));
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("discard corrupt entries rather than returning unverified data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iq-corrupt-cache-"));
  try {
    const cache = new VerifiedObjectDiskCache(dir, 1024);
    const data = Buffer.from("verified");
    await cache.put("id", digest(data), data);
    const [name] = await readdir(dir);
    await writeFile(join(dir, name), Buffer.from("tampered"));
    const restarted = new VerifiedObjectDiskCache(dir, 1024);
    expect(await restarted.get("id", digest(data))).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
    await restarted.put("id", digest(data), data);
    expect(await restarted.get("id", digest(data))).toEqual(data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
