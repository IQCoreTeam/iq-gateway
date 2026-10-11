import { isPreformattedText } from "../../inscription-layout";
import { Hono } from "hono";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../../cache";
import { escapeMarkup } from "./render";
import { isTxHash } from "../../utils";
import type { EvmEnv } from "../../chain/wrappers";
import { NETWORKS, type NetworkMode } from "../../chain/evm/networks";

export const viewRouter = new Hono<EvmEnv>();

// explorerTxUrl points at the chain's block explorer for this tx (Blockscout on
// Robinhood, etc). The footer carries two actions on the ON-CHAIN side: a
// how-to-check guide (a :target modal, no inline JS so it survives CSP) and a
// direct explorer link, so a reader can verify the raw on-chain write.
export function renderHtmlPage(text: string, txHash: string, baseUrl: string, explorerTxUrl: string): string {
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
  min-height: 80px; max-height: 80vh; overflow: auto;
  font-size: 20px; font-weight: bold; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
  text-shadow: 0 0 6px rgba(65, 255, 0, 0.4);
}
.content.preformatted { white-space: pre; word-break: normal; overflow-wrap: normal; font-size: clamp(12px, 2.4vw, 20px); line-height: 1.35; tab-size: 4; }
.footer { background: #f0f0f0; color: #006400; padding: 6px 10px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px 12px; justify-content: space-between; align-items: center; }
.footer-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.footer-btn {
  font-family: inherit; font-size: 11px; color: #006400; background: #e0e0e0;
  border: 1px solid #808080; padding: 1px 7px; cursor: pointer; text-decoration: none;
  display: inline-block; line-height: 1.6;
}
.footer-btn:hover { background: #d0d0d0; }
.onchain { font-weight: bold; }
@media (max-width: 480px) { body { padding: 12px; } .content { padding: 12px; } }
::selection { background: #41FF00; color: #000; }

/* How-to modal, toggled by the url hash (no inline JS, CSP-safe) */
.howto { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: none; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
.howto:target { display: flex; }
.howto-box { background: #c0c0c0; width: 100%; max-width: 560px; padding: 4px; font-family: inherit; }
.howto-title { background: linear-gradient(90deg,#000,#006400); color:#41FF00; padding: 5px 9px; display:flex; justify-content:space-between; font-weight:bold; font-size:13px; }
.howto-title a { color:#41FF00; text-decoration:none; }
.howto-body { background:#f0f0f0; color:#000; padding: 14px 16px; font-size: 12px; line-height: 1.65; }
.howto-body h4 { color:#006400; margin: 0 0 6px; letter-spacing:.05em; font-size:12px; }
.howto-body h4.mt { margin-top: 12px; }
.howto-body p { margin: 0; }
.howto-body ol { margin: 0; padding-left: 18px; }
.howto-go { display:inline-block; margin-top: 14px; background:#006400; color:#fff; padding:5px 12px; text-decoration:none; font-weight:bold; }
</style>
</head>
<body>
<div class="window">
  <div class="title-bar"><span>IQLabs — ${escapeMarkup(short)}</span><span>_  □  ✕</span></div>
  <div class="content${isJson || isPreformattedText(text) ? " preformatted" : ""}" tabindex="0" role="region" aria-label="Inscription content">${isJson ? "<pre>" : ""}${displayContent}${isJson ? "</pre>" : ""}</div>
  <div class="footer">
    <span>inscribed on EVM via iqlabs</span>
    <span class="footer-actions">
      <a class="footer-btn" href="#howto">how to check my data</a>
      <a class="footer-btn" href="${explorerTxUrl}" target="_blank" rel="noopener">view on explorer</a>
      <span class="onchain">● ON-CHAIN</span>
    </span>
  </div>
</div>

<div class="howto" id="howto">
  <div class="howto-box">
    <div class="howto-title"><span>how_to_view.exe</span><a href="#" aria-label="close">x</a></div>
    <div class="howto-body">
      <h4>// HOW YOUR INSCRIPTION LIVES ON-CHAIN</h4>
      <p>Your post is a permanent IQLabs code-in write on EVM. The text or image is split into chunks committed in transactions that reference each other; this viewer and the IQLabs gateway reassemble the row (kind, body, who).</p>
      <h4 class="mt">// VERIFY IT ON THE EXPLORER</h4>
      <ol>
        <li>Open the transaction with the button below.</li>
        <li>You will see the code-in write, proof it is on chain forever.</li>
        <li>The explorer shows the raw on-chain transaction; the readable text or image is reassembled from the chunks by this viewer and the IQLabs gateway.</li>
      </ol>
      <a class="howto-go" href="${explorerTxUrl}" target="_blank" rel="noopener">Go to explorer</a>
    </div>
  </div>
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
  const chain = c.get("chain");
  const network = c.get("network");

  const cacheKey = `${network}:view:${txHash}`;
  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("view", txHash, network);
    if (disk) { buf = disk; imageCache.set(cacheKey, buf, TTL.IMAGE); }
  }

  if (!buf) {
    try {
      const { data } = await chain.readAsset(txHash);
      if (!data) return c.text("not found", 404);
      buf = chain.decodeAssetData(data);
      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("view", txHash, buf, network);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      console.error("view fetch error:", msg);
      return c.text("failed to fetch", 500);
    }
  }

  if (chain.detectImageType(buf)) return c.redirect(`/img/${txHash}`, 302);

  const text = buf.toString("utf-8");
  const proto = c.req.header("X-Forwarded-Proto") || "https";
  const host = c.req.header("Host") || "localhost:3000";
  const basePath = process.env.BASE_PATH || "";
  const baseUrl = `${proto}://${host}${basePath}`;
  const explorerTxUrl = `${NETWORKS[network as NetworkMode].explorer}/tx/${txHash}`;
  const html = renderHtmlPage(text, txHash, baseUrl, explorerTxUrl);

  const etag = chain.generateETag(html);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.html(html, 200, {
    "Cache-Control": "public, max-age=300, must-revalidate",
    ETag: etag,
  });
});
