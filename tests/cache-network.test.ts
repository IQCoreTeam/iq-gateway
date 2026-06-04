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

describe("/search route — passes ?network through to the catalog", () => {
  test("?network scopes results; omitted spans all networks", async () => {
    const { searchRouter } = await import("../src/routes/search");
    await upsertCatalogEntry({ kind: "row", id: "0xRS", network: "sepolia", dbroot: "", label: "rs", snippet: "beta", body: "beta sepolia route" });
    await upsertCatalogEntry({ kind: "row", id: "0xRM", network: "monad", dbroot: "", label: "rm", snippet: "beta", body: "beta monad route" });

    const json = async (path: string) =>
      (await searchRouter.request(path)).json() as Promise<{ network?: string; hits: { id: string }[]; count: number }>;

    const sep = await json("/?q=route&network=sepolia");
    expect(sep.network).toBe("sepolia");
    expect(sep.hits.map((h) => h.id)).toEqual(["0xRS"]);

    const mon = await json("/?q=route&network=monad");
    expect(mon.hits.map((h) => h.id)).toEqual(["0xRM"]);

    const all = await json("/?q=route");
    expect(all.network).toBeUndefined();          // no network echoed when unfiltered
    expect(all.hits.map((h) => h.id).sort()).toEqual(["0xRM", "0xRS"]);

    // Unknown network must not 4xx (search never rejects on shape) — just no hits.
    const res = await searchRouter.request("/?q=route&network=nope");
    expect(res.status).toBe(200);
    expect((await res.json() as { count: number }).count).toBe(0);
  });
});
