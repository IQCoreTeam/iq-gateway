import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/routes/site";

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
});
