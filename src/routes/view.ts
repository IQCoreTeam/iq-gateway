import { Hono } from "hono";
import { readAsset, generateETag, decodeAssetData, detectImageType } from "../chain";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../cache";
import { escapeMarkup } from "./render";

export const viewRouter = new Hono();

function renderHtmlPage(text: string, sig: string): string {
  const shortSig = sig.slice(0, 8) + "..." + sig.slice(-8);

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
<title>IQLabs — ${escapeMarkup(shortSig)}</title>
<meta property="og:title" content="IQLabs Inscription"/>
<meta property="og:description" content="${escapeMarkup(text.slice(0, 200))}"/>
<meta property="og:image" content="https://gateway.iqlabs.dev/render/${sig}"/>
<style>
* { margin:0; padding:0; box-sizing:border-box; }

@keyframes scanmove {
  0%   { background-position: 0 0; }
  100% { background-position: 0 4px; }
}
@keyframes scanbar {
  0%   { transform: translateY(-100px); }
  100% { transform: translateY(calc(100vh + 100px)); }
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.6; }
}

body {
  background: #002100;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-family: 'DejaVu Sans Mono', 'Courier New', Courier, monospace;
  position: relative;
  overflow-x: hidden;
}

/* Full-page scanline overlay */
body::before {
  content: '';
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background-image: repeating-linear-gradient(
    0deg, transparent, transparent 2px,
    rgba(0, 255, 0, 0.03) 2px, rgba(0, 255, 0, 0.03) 4px
  );
  animation: scanmove 8s linear infinite;
  pointer-events: none;
  z-index: 0;
}

/* Moving scan bar across the whole page */
body::after {
  content: '';
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 100px;
  background: linear-gradient(
    to bottom, transparent 0%,
    rgba(65, 255, 0, 0.06) 50%, transparent 100%
  );
  animation: scanbar 4s linear infinite;
  pointer-events: none;
  z-index: 9999;
}


/* Win95 window — raised 3D border */
.window {
  width: 100%;
  max-width: 800px;
  background: #c0c0c0;
  border-top: 2px solid #dfdfdf;
  border-left: 2px solid #dfdfdf;
  border-right: 2px solid #404040;
  border-bottom: 2px solid #404040;
  box-shadow:
    inset 1px 1px 0 #fff,
    inset -1px -1px 0 #000,
    0 0 60px rgba(65, 255, 0, 0.12),
    0 0 120px rgba(65, 255, 0, 0.06);
  z-index: 1;
}

/* Title bar — black → dark green gradient */
.title-bar {
  background: linear-gradient(90deg, #000000, #006400);
  padding: 4px 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  margin: 4px 4px 0 4px;
  user-select: none;
}
.title-bar .title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #41FF00;
  font-size: 16px;
  font-weight: bold;
  text-shadow: 0 0 8px #00ff22;
}
.title-bar .title .title-logo {
  width: 28px; height: 28px;
  filter: brightness(1.2);
}

/* Win95 title buttons */
.title-buttons { display: flex; gap: 2px; }
.title-buttons button {
  width: 20px; height: 20px;
  background: #c0c0c0;
  border-top: 2px solid #dfdfdf;
  border-left: 2px solid #dfdfdf;
  border-right: 2px solid #404040;
  border-bottom: 2px solid #404040;
  font-size: 12px;
  line-height: 14px;
  cursor: default;
  color: #000;
  font-family: inherit;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.title-buttons button:active {
  border-top-color: #404040;
  border-left-color: #404040;
  border-right-color: #dfdfdf;
  border-bottom-color: #dfdfdf;
}

/* Content area — inset border */
.content-wrap {
  margin: 4px 4px;
  border-top: 2px solid #808080;
  border-left: 2px solid #808080;
  border-right: 2px solid #dfdfdf;
  border-bottom: 2px solid #dfdfdf;
  position: relative;
  overflow: hidden;
}
.content-area {
  background: #0a0a0a;
  padding: 28px;
  min-height: 80px;
  max-height: 80vh;
  overflow-y: auto;
  font-size: 20px;
  font-weight: bold;
  line-height: 1.5;
  color: #41FF00;
  white-space: pre-wrap;
  word-break: break-word;
  text-shadow: 0 0 6px rgba(65, 255, 0, 0.4);
  position: relative;
  /* Scanlines */
  background-image:
    repeating-linear-gradient(
      0deg,
      rgba(65, 255, 0, 0.03) 0px,
      rgba(65, 255, 0, 0.03) 1px,
      transparent 1px,
      transparent 4px
    );
}
.content-area pre {
  font-family: inherit;
  font-size: inherit;
  font-weight: inherit;
  color: inherit;
  margin: 0;
}

/* CRT scan bar on content */
.content-wrap::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 60px;
  background: linear-gradient(
    to bottom, transparent 0%,
    rgba(65, 255, 0, 0.08) 50%, transparent 100%
  );
  animation: scanbar 3s linear infinite;
  pointer-events: none;
  z-index: 2;
}

/* Custom scrollbar — green on dark */
.content-area::-webkit-scrollbar { width: 14px; }
.content-area::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
}
.content-area::-webkit-scrollbar-thumb {
  background: rgba(65, 255, 0, 0.3);
  border-radius: 6px;
  border: 2px solid rgba(0, 0, 0, 0.3);
}
.content-area::-webkit-scrollbar-thumb:hover {
  background: rgba(65, 255, 0, 0.5);
}
.content-area::-webkit-scrollbar-thumb:active {
  background: rgba(65, 255, 0, 0.7);
}

/* Footer — Win95 status bar with inset panels */
.status-bar {
  display: flex;
  gap: 2px;
  padding: 4px;
}
.status-panel {
  flex: 1;
  padding: 2px 8px;
  font-size: 12px;
  color: #000;
  border-top: 1px solid #808080;
  border-left: 1px solid #808080;
  border-right: 1px solid #fff;
  border-bottom: 1px solid #fff;
  background: #f0f0f0;
  display: flex;
  align-items: center;
  height: 24px;
}
.status-panel.right {
  flex: 0 0 auto;
  gap: 6px;
  font-weight: bold;
  color: #006400;
}
.status-dot {
  width: 8px; height: 8px;
  background: #41FF00;
  display: inline-block;
  box-shadow: 0 0 4px #41FF00;
  animation: pulse 2s ease-in-out infinite;
}

.status-panel.sol-panel {
  flex: 0 0 auto;
  padding: 0 4px;
  justify-content: center;
  background: transparent;
  border: none;
}
.status-sol-internet {
  height: 72px;
  filter: drop-shadow(0 0 6px rgba(65, 255, 0, 0.5));
  vertical-align: middle;
}

/* Selection color */
::selection { background: #41FF00; color: #000; }
</style>
</head>
<body>

<div class="window">
  <div class="title-bar">
    <span class="title">
      <img class="title-logo" src="/iq_logo.svg" alt=""/>
      IQLabs — ${escapeMarkup(shortSig)}
    </span>
    <div class="title-buttons">
      <button>_</button><button>□</button><button>✕</button>
    </div>
  </div>
  <div class="content-wrap">
    <div class="content-area">${isJson ? "<pre>" : ""}${displayContent}${isJson ? "</pre>" : ""}</div>
  </div>
  <div class="status-bar">
    <div class="status-panel">inscribed on solana via iqlabs</div>
    <div class="status-panel right"><span class="status-dot"></span> ON-CHAIN</div>
    <div class="status-panel sol-panel"><img class="status-sol-internet" src="/solana-internet.png" alt="Solana Internet"/></div>
  </div>
</div>


</body>
</html>`;
}

viewRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".html", ".json", ".txt"]) {
    if (sig.endsWith(ext)) {
      sig = sig.slice(0, -ext.length);
      break;
    }
  }
  if (!sig || sig.length < 80) return c.text("invalid signature", 400);

  const cacheKey = `view:${sig}`;

  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("view", sig);
    if (disk) {
      buf = disk;
      imageCache.set(cacheKey, buf, TTL.IMAGE);
    }
  }

  if (!buf) {
    try {
      const { data } = await readAsset(sig);
      if (!data) return c.text("not found", 404);

      buf = decodeAssetData(data);

      imageCache.set(cacheKey, buf, TTL.IMAGE);
      await setDiskCache("view", sig, buf);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown error";
      if (msg.includes("abort")) return c.text("timeout", 504);
      console.error("view fetch error:", msg);
      return c.text("failed to fetch", 500);
    }
  }

  if (detectImageType(buf)) {
    return c.redirect(`/img/${sig}`, 302);
  }

  const text = buf.toString("utf-8");
  const html = renderHtmlPage(text, sig);

  const etag = generateETag(html);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);

  return c.html(html, 200, {
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  });
});
