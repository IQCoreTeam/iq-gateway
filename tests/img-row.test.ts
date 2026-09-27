import { expect, test } from "bun:test";

// Other route suites replace the Solana module with mocks. Exercise the real
// decoder, Hono route and disk cache in an isolated process, without RPC calls.
test("img unwraps image rows and repairs caches without changing legacy images", () => {
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { strict as assert } from "node:assert";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const root = mkdtempSync(join(tmpdir(), "iq-img-test-"));
    process.env.CACHE_DIR = root;
    try {
      const { imgRouter } = await import("./src/routes/img");
      const { imageCache, getDiskCache, setDiskCache, TTL } = await import("./src/cache");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=", "base64");
      const webp = Buffer.from("RIFF0000WEBPVP8 ");
      const row = (kind, body) => Buffer.from(JSON.stringify({kind, body, who:"owner"}));
      const cases = [
        [png, png, "image/png"],
        [webp, webp, "image/webp"],
        [row("image", "data:image/png;base64,"+png.toString("base64")), png, "image/png"],
        [row("file", "data:image/webp;name=test.webp;base64,"+webp.toString("base64")), webp, "image/webp"],
      ];
      for (const input of [
        row("text", "data:image/png;base64,"+png.toString("base64")),
        row("file", "data:audio/mpeg;base64,SUQz"),
        row("image", "data:image/png;base64,not-valid!"),
        row("image", "data:image/png;base64,"+Buffer.from("<script>alert(1)</script>").toString("base64")),
        Buffer.from('{"body":"https://example.com/image.png"}'),
        Buffer.from("{broken json"),
      ]) cases.push([input, input, "image/png"]);
      let n = 0;
      for (const tier of ["memory", "disk"]) for (const [input, expected, mime] of cases) {
        const sig = String(++n).padStart(3,"0") + "1".repeat(85);
        if (tier === "memory") imageCache.set("img:"+sig, input, TTL.IMAGE);
        else await setDiskCache("img", sig, input);
        const response = await imgRouter.request("/"+sig+".png");
        assert.equal(response.status,200);
        assert.equal(response.headers.get("content-type"),mime);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
        if (input !== expected) assert.deepEqual(await getDiskCache("img",sig),expected);
        const again = await imgRouter.request("/"+sig+".png",{headers:{"If-None-Match":response.headers.get("etag")}});
        assert.equal(again.status,304);
      }
      console.log("20 cache/format cases + ETag checks passed");
    } finally { rmSync(root,{recursive:true,force:true}); }
  `], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(result.stderr)).not.toContain("AssertionError");
  expect(result.exitCode).toBe(0);
});
