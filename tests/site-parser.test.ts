import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import bs58 from "bs58";
import { parseManifest, resolveFile, siteRouter } from "../src/routes/site";

describe("parseManifest", () => {
  test("gateway format with index.path", () => {
    const raw = {
      index: { path: "gameboy.html" },
      paths: {
        "gameboy.html": { id: "tx-html" },
        "assets/style.css": { id: "tx-css" },
      },
    };
    const manifest = parseManifest(raw);
    expect(manifest.indexPath).toBe("gameboy.html");
    expect(manifest.files).toEqual({
      "gameboy.html": "tx-html",
      "assets/style.css": "tx-css",
    });
  });

  test("gateway format without index defaults to index.html", () => {
    const raw = { paths: { "index.html": { id: "tx-html" } } };
    const manifest = parseManifest(raw);
    expect(manifest.indexPath).toBe("index.html");
    expect(manifest.files["index.html"]).toBe("tx-html");
  });

  test("iqoogle format (txId at top level)", () => {
    const raw = {
      "gameboy.html": { txId: "tx-html", hash: "h1" },
      "assets/style.css": { txId: "tx-css", hash: "h2" },
    };
    const manifest = parseManifest(raw);
    expect(manifest.indexPath).toBe("index.html");
    expect(manifest.files).toEqual({
      "gameboy.html": "tx-html",
      "assets/style.css": "tx-css",
    });
  });

  test("entries without id/txId are dropped", () => {
    const raw = {
      paths: {
        "good": { id: "tx-good" },
        "bad-empty": {},
      },
    };
    const manifest = parseManifest(raw);
    expect(manifest.files["good"]).toBe("tx-good");
    expect(manifest.files["bad-empty"]).toBeUndefined();
  });

  test("empty raw -> no files (caller should reject)", () => {
    const manifest = parseManifest({});
    expect(Object.keys(manifest.files).length).toBe(0);
  });

  test("only resolves string entries owned by the site manifest", () => {
    const raw = JSON.parse('{"index":{"path":42},"paths":{"index.html":{"id":"tx-html"},"number":{"id":42}}}');
    const manifest = parseManifest(raw);
    expect(resolveFile(manifest, "/")).toBe("tx-html");
    expect(resolveFile(manifest, "/number")).toBeNull();
    expect(resolveFile({ ...manifest, files: { "index.html": "tx-html" } }, "/constructor")).toBeNull();
  });
});

test("site index redirects to its directory URL without losing the archive query", async () => {
  const signature = bs58.encode(Buffer.alloc(64, 87));
  const path = `/site/${signature}`;
  const response = await new Hono().route("/site", siteRouter).request(path + "?id=archive");
  expect(response.status).toBe(308);
  expect(response.headers.get("Location")).toBe(path + "/?id=archive");
});
