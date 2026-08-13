import { describe, expect, test } from "bun:test";
import { openapiSpec } from "../src/openapi";

// Pins the spec additions themselves (the handlers pre-existed; their specs
// didn't): the once-missing paths stay present, every tag used by an
// operation is declared (Swagger UI silently drops grouping otherwise), and
// the server picker has no duplicate URLs (a verbatim-duplicated production
// entry used to render twice).
describe("openapi spec", () => {
  test("documents the once-missing public endpoints", () => {
    const added = [
      "/table/{tablePda}/threads",
      "/skill/{mint}/{file}",
      "/collection/{mint}",
      "/cache/backup",
      "/search",
      "/search/stats",
      "/sns/tls-check",
      "/sns/{domain}/pointer",
      "/sns/{domain}/url",
    ];
    for (const p of added) expect(openapiSpec.paths).toHaveProperty([p]);
  });

  test("every operation tag is declared in the top-level tags list", () => {
    const declared = new Set(openapiSpec.tags.map((t) => t.name));
    for (const [path, item] of Object.entries(openapiSpec.paths)) {
      for (const op of Object.values(item as Record<string, { tags?: string[] }>)) {
        for (const tag of op.tags ?? []) {
          expect(declared.has(tag), `undeclared tag "${tag}" on ${path}`).toBe(true);
        }
      }
    }
  });

  test("server URLs are unique", () => {
    const urls = openapiSpec.servers.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("/search spec does not claim FTS5 operator pass-through", () => {
    // searchCatalog quotes every token, so OR/NOT/phrases are literal text;
    // the spec must not promise "pass through" (the bug this entry once had).
    const desc = openapiSpec.paths["/search"].get.description;
    expect(desc).not.toMatch(/pass(es)? through/i);
    expect(desc).toContain("literal text");
  });
});
