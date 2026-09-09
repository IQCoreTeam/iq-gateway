import { describe, expect, test } from "bun:test";

import "./helpers/cache-fixture";

const { collectionRouter } = await import("../src/routes/skill");

const SKILLS = "BUGHnCh2Pf93tgcxAEfhjd6tUjbY56JrSZdCRXyt7uS5";
const BROWSER = (process.env.BROWSER_URL || "https://browser.iqlabs.dev").replace(/\/+$/, "");

const get = (path: string) => collectionRouter.request(path);

describe("/collection/{mint}", () => {
  test("serves the collection metadata JSON with a render-layer image url", async () => {
    const res = await get(`/${SKILLS}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.name).toBe("AgentNet Skills");
    expect(json.image).toBe(`${BROWSER}/collection/${SKILLS}.png`);
    expect(res.headers.get("Cache-Control")).toContain("max-age=86400");
  });

  test(".png redirects to the render layer instead of serving JSON as an image", async () => {
    const res = await get(`/${SKILLS}.png`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`${BROWSER}/collection/${SKILLS}.png`);
  });

  test("unknown mint stays a JSON 404, with or without .png", async () => {
    expect((await get("/NotARealMint11111111111111111111111111111111")).status).toBe(404);
    expect((await get("/NotARealMint11111111111111111111111111111111.png")).status).toBe(404);
  });

  test("ETag revalidation still returns 304 on the JSON path", async () => {
    const first = await get(`/${SKILLS}`);
    const etag = first.headers.get("ETag")!;
    const res = await collectionRouter.request(`/${SKILLS}`, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
  });
});
