import { Hono } from "hono";
import { readAsset, generateETag, decodeAssetData, detectImageType } from "../../chain/evm";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../../cache";
import { escapeMarkup } from "./render";
import { isTxHash } from "../../utils";

export const viewRouter = new Hono();

function renderHtmlPage(text: string, txHash: string, baseUrl: string): string {
  const short = txHash.slice(0, 10) + "..." + txHash.slice(-8);

  let displayContent: string;
  let isJson = false;
  try {
    const parsed = JSON.parse(text);
    displayContent = escapeMarkup(JSON.stringify(parsed, null, 2));
    isJson = true;
  } catch {
    displayContent = escapeMarkup(text);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>IQLabs — ${escapeMarkup(short)}</title>
<meta property="og:title" content="IQLabs Inscription"/>
<meta property="og:description" content="${escapeMarkup(text.slice(0, 200))}"/>
<meta property="og:image" content="${baseUrl}/render/${txHash}"/>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  background: #002100;
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  font-family: 'DejaVu Sans Mono', 'Courier New', monospace;
}
.window { width: 100%; max-width: 800px; background: #c0c0c0; padding: 4px; }
.title-bar {
  background: linear-gradient(90deg, #000, #006400);
  padding: 6px 10px; color: #41FF00; font-weight: bold;
  display: flex; justify-content: space-between;
}
.content {
  background: #0a0a0a; color: #41FF00; padding: 28px;
  min-height: 80px; max-height: 80vh; overflow-y: auto;
  font-size: 20px; font-weight: bold; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
  text-shadow: 0 0 6px rgba(65, 255, 0, 0.4);
}
.footer { background: #f0f0f0; color: #006400; padding: 6px 10px; font-size: 12px; display: flex; justify-content: space-between; }
::selection { background: #41FF00; color: #000; }
</style>
</head>
<body>
<div class="window">
  <div class="title-bar"><span>IQLabs — ${escapeMarkup(short)}</span><span>_  □  ✕</span></div>
  <div class="content">${isJson ? "<pre>" : ""}${displayContent}${isJson ? "</pre>" : ""}</div>
  <div class="footer"><span>inscribed on EVM via iqlabs</span><span>● ON-CHAIN</span></div>
</div>
</body>
</html>`;
}

viewRouter.get("/:txHash", async (c) => {
  let txHash = c.req.param("txHash");
  for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".html", ".json", ".txt"]) {
    if (txHash.endsWith(ext)) { txHash = txHash.slice(0, -ext.length); break; }
  }
  if (!isTxHash(txHash)) return c.text("invalid tx hash", 400);

  const cacheKey = `view:${txHash}`;
  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("view", txHash);
    if (disk) { buf = disk; imageCache.set(cacheKey, buf, TTL.IMAGE); }
  }

  if (!buf) {
    try {
      const { data } = await readAsset(txHash);
      if (!data) return c.text("not found", 404);
      buf = decodeAssetData(data);
      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("view", txHash, buf);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      console.error("view fetch error:", msg);
      return c.text("failed to fetch", 500);
    }
  }

  if (detectImageType(buf)) return c.redirect(`/img/${txHash}`, 302);

  const text = buf.toString("utf-8");
  const proto = c.req.header("X-Forwarded-Proto") || "https";
  const host = c.req.header("Host") || "localhost:3000";
  const basePath = process.env.BASE_PATH || "";
  const baseUrl = `${proto}://${host}${basePath}`;
  const html = renderHtmlPage(text, txHash, baseUrl);

  const etag = generateETag(html);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.html(html, 200, {
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
