import { expect, test } from "bun:test";

// Keep process-wide chain mocks from other suites out of the real cache/media path.
test("share previews decode cached WebP records and metadata into PNG; icons survive a different cwd", () => {
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import assert from "node:assert/strict";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import sharp from "sharp";
    const cwd = process.cwd(), tmp = mkdtempSync(join(tmpdir(), "iq-share-test-"));
    process.env.CACHE_DIR = tmp;
    try {
      const { renderRouter } = await import("./src/routes/render");
      const { faviconRouter } = await import("./src/routes/favicon");
      const { viewRouter } = await import("./src/routes/view");
      const { imageCache, TTL } = await import("./src/cache");
      const { RENDER_REVISION } = await import("./src/branding");
      globalThis.fetch = () => { throw Error("Unexpected network request"); };
      const sig = "2".repeat(88), metaSig = "3".repeat(88);
      const webp = await sharp({ create: { width: 20, height: 12, channels: 3, background: "#41ff00" } }).webp().toBuffer();
      imageCache.set("img:"+sig, Buffer.from(JSON.stringify({kind:"image",body:"data:image/webp;base64,"+webp.toString("base64"),who:"fixture"})),TTL.IMAGE);
      imageCache.set("render:branding-2-png:"+sig,Buffer.from("stale JSON preview"),TTL.IMAGE);
      for (const key of [sig, metaSig]) {
        if(key===metaSig) imageCache.set("img:"+key,Buffer.from(JSON.stringify({name:"Fixture NFT",image:"http://127.0.0.1:1/not-fetched",attributes:[{trait_type:"inscription",value:sig}]})),TTL.IMAGE);
        const response=await renderRouter.request("/"+key+"?v="+RENDER_REVISION);
        assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"image/png");
        const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),"PNG");
        const metadata=await sharp(bytes).metadata();assert.equal(metadata.width,20);assert.equal(metadata.height,12);
        const second=await renderRouter.request("/"+key,{headers:{"If-None-Match":response.headers.get("etag")}});assert.equal(second.status,304);
      }
      imageCache.set("view:"+metaSig, Buffer.from(JSON.stringify({name:"Fixture NFT",description:"An inscription NFT",image:"https://example.invalid/image",attributes:[{trait_type:"inscription",value:sig}]})),TTL.IMAGE);
      const page=await (await viewRouter.request("/"+metaSig)).text();
      assert(page.includes('property="og:title" content="Fixture NFT"'));
      assert(page.includes('name="twitter:card" content="summary_large_image"'));
      assert(page.includes("/favicon.png?v="+RENDER_REVISION));
      // Arbitrary metadata image URLs do not trigger a server-side fetch.
      const external="4".repeat(88);
      imageCache.set("img:"+external,Buffer.from(JSON.stringify({name:"External",image:"http://127.0.0.1:1/private"})),TTL.IMAGE);
      assert.equal((await renderRouter.request("/"+external)).status,200);
      process.chdir(tmp);
      for(const ext of ["ico","png"]){const r=await faviconRouter.request("/favicon."+ext+"?v="+RENDER_REVISION);assert.equal(r.status,200);assert((await r.arrayBuffer()).byteLength>100);assert(r.headers.get("content-type").startsWith("image/"));}
      process.chdir(cwd);
      console.log("PNG content, metadata image pointers, cache revision/ETag, no network and favicon cwd checks passed");
    } finally { process.chdir(cwd); rmSync(tmp,{recursive:true,force:true}); }
  `], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(result.stderr)).not.toContain("AssertionError");
  expect(result.exitCode).toBe(0);
});
