import { expect, test } from "bun:test";

test("an NFT preview retries a temporarily unavailable referenced image", () => {
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import sharp from "sharp";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";

    const cacheDir = mkdtempSync(join(tmpdir(), "iq-render-retry-"));
    process.env.CACHE_DIR = cacheDir;
    try {
      const chain = await import("./src/chain/solana");
      const imageSig = "2".repeat(88);
      const metaSig = "3".repeat(88);
      let available = false;
      let imageReads = 0;
      const image = await sharp({
        create: { width: 20, height: 12, channels: 3, background: "green" },
      }).png().toBuffer();
      mock.module("./src/chain/solana", () => ({
        ...chain,
        async readAsset(sig) {
          if (sig === metaSig) {
            return { data: JSON.stringify({ name: "Fixture", attributes: [{ trait_type: "inscription", value: imageSig }] }) };
          }
          imageReads++;
          if (!available) throw new Error("Fixture: RPC temporarily unavailable");
          return { data: JSON.stringify({ kind: "image", body: "data:image/png;base64," + image.toString("base64") }) };
        },
      }));
      const { initCacheStore } = await import("./src/cache/store");
      const { renderRouter } = await import("./src/routes/render");
      await initCacheStore();

      const fallback = await renderRouter.request("/" + metaSig);
      assert.equal(fallback.status, 200);
      assert.equal(fallback.headers.get("Cache-Control"), "no-store");
      assert.equal(imageReads, 1);

      available = true;
      const response = await renderRouter.request("/" + metaSig, { headers: { "If-None-Match": fallback.headers.get("ETag") } });
      assert.equal(response.status, 200);
      assert.equal(imageReads, 2);
      assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, 20);

      const cached = await renderRouter.request("/" + metaSig, { headers: { "If-None-Match": response.headers.get("ETag") } });
      assert.equal(cached.status, 304);
      assert.equal(imageReads, 2);
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  `], { stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
