import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

// Isolated cache dir for this test file (set before importing the cache layer).
const TEST_DIR = `/tmp/iq-cache-network-test-${process.pid}`;
process.env.CACHE_DIR = TEST_DIR;

const { getDiskCache, setDiskCache } = await import("../src/cache/disk");
const { upsertCatalogEntry, searchCatalog } = await import("../src/cache/catalog");
const { initCacheStore } = await import("../src/cache/store");

await initCacheStore();

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("disk cache — per-network isolation", () => {
  test("same (type,key) on two EVM networks does NOT collide", async () => {
    await setDiskCache("meta", "0xABC", JSON.stringify({ n: "sepolia" }), "sepolia");
    await setDiskCache("meta", "0xABC", JSON.stringify({ n: "monad" }), "monad");

    const sep = await getDiskCache("meta", "0xABC", "sepolia");
    const mon = await getDiskCache("meta", "0xABC", "monad");

    expect(sep?.toString()).toBe(JSON.stringify({ n: "sepolia" }));
    expect(mon?.toString()).toBe(JSON.stringify({ n: "monad" }));
    expect(sep?.toString()).not.toBe(mon?.toString());
  });

  test("default network (omitted) is unprefixed and distinct from a named net", async () => {
    await setDiskCache("rows", "k1", "legacy-solana");          // omitted → 'solana'
    await setDiskCache("rows", "k1", "monad-rows", "monad");

    const legacy = await getDiskCache("rows", "k1");            // omitted → 'solana'
    const explicitSol = await getDiskCache("rows", "k1", "solana");
    const monad = await getDiskCache("rows", "k1", "monad");

    expect(legacy?.toString()).toBe("legacy-solana");
    expect(explicitSol?.toString()).toBe("legacy-solana"); // 'solana' == default → same entry
    expect(monad?.toString()).toBe("monad-rows");
  });

  test("a network miss returns null even when another net has the key", async () => {
    await setDiskCache("img", "0xIMG", Buffer.from("sep"), "sepolia");
    expect(await getDiskCache("img", "0xIMG", "monad")).toBeNull();
    expect((await getDiskCache("img", "0xIMG", "sepolia"))?.toString()).toBe("sep");
  });
});

describe("catalog — per-network search filter", () => {
  test("search filters by network; unfiltered returns both", async () => {
    await upsertCatalogEntry({ kind: "row", id: "0xS", network: "sepolia", dbroot: "", label: "s", snippet: "alpha", body: "alpha sepolia content" });
    await upsertCatalogEntry({ kind: "row", id: "0xM", network: "monad", dbroot: "", label: "m", snippet: "alpha", body: "alpha monad content" });

    const sep = await searchCatalog("content", { network: "sepolia" });
    const mon = await searchCatalog("content", { network: "monad" });
    const all = await searchCatalog("content", {});

    expect(sep.map((h) => h.id)).toEqual(["0xS"]);
    expect(mon.map((h) => h.id)).toEqual(["0xM"]);
    expect(all.map((h) => h.id).sort()).toEqual(["0xM", "0xS"]);
  });
});
