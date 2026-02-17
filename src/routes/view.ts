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

body {
  background: #002100;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-family: 'DejaVu Sans Mono', 'Courier New', Courier, monospace;
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
    inset -1px -1px 0 #000;
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
  color: #41FF00;
  font-size: 16px;
  font-weight: bold;
  text-shadow: 0 0 8px #00ff22;
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

/* Win95 scrollbar */
.content-area::-webkit-scrollbar { width: 18px; }
.content-area::-webkit-scrollbar-track {
  background: #c0c0c0;
  border-left: 1px solid #808080;
}
.content-area::-webkit-scrollbar-thumb {
  background: #c0c0c0;
  border-top: 2px solid #dfdfdf;
  border-left: 2px solid #dfdfdf;
  border-right: 2px solid #404040;
  border-bottom: 2px solid #404040;
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
}

/* Selection color */
::selection { background: #41FF00; color: #000; }
</style>
</head>
<body>
<div class="window">
  <div class="title-bar">
    <span class="title">IQLabs — ${escapeMarkup(shortSig)}</span>
    <div class="title-buttons">
      <button>_</button><button>□</button><button>✕</button>
    </div>
  </div>
  <div class="content-wrap">
    <div class="content-area">${isJson ? "<pre>" : ""}${displayContent}${isJson ? "</pre>" : ""}</div>
  </div>
  <div class="status-bar">
    <div class="status-panel">inscribed on solana via iqlabs • gateway.iqlabs.dev</div>
    <div class="status-panel right"><span class="status-dot"></span> ON-CHAIN</div>
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
