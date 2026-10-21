import { Hono } from "hono";
import { readAsset, generateETag, decodeAssetData, detectImageType, parseRecord } from "../chain/solana";
import { isPreformattedText } from "../inscription-layout";
import { RENDER_REVISION, SOLANA_INTERNET_LOGO } from "../branding";
import { imageCache, TTL, getDiskCache, setDiskCache } from "../cache";
import { escapeMarkup } from "./render";

export const viewRouter = new Hono();

// ── small helpers ──────────────────────────────────────────────────────────
function humanSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
function shortId(s: string): string {
  return s.length > 18 ? `${s.slice(0, 8)}...${s.slice(-6)}` : s;
}
// A data: URL is safe to drop into an attribute only when it is exactly a
// base64 payload of the expected media type and carries no attribute breakers.
function safeDataUrl(s: string, media: RegExp, maxLen = 6_000_000): boolean {
  return s.length <= maxLen && !/["'<>]/.test(s) && media.test(s);
}

// ── per-kind content: one dispatch, one place ───────────────────────────────
// Images are delegated to /img (the single image-bytes endpoint, shared with
// NFT render + posts); everything else is built from the decoded record.
interface Screen { kind: string; size: string; who: string; top: boolean; html: string; }

const imgScreen = (baseUrl: string, sig: string): string =>
  `<img class="v-img" alt="inscribed image" src="${baseUrl}/img/${sig}">`;

function audioScreen(body: string, who: string): string {
  const player = safeDataUrl(body, /^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i)
    ? `<audio controls preload="none" style="width:100%;margin-top:14px" src="${body}"></audio>`
    : `<div class="dim" style="margin-top:14px">audio body unavailable on this rpc</div>`;
  return `<div class="deck"><div class="cover">no cover</div><div><div>on-chain audio</div><div class="dim">${escapeMarkup(who)}</div>${player}</div></div>`;
}

function fileScreen(body: string): string {
  const name = /;name=([^;,]+)/i.exec(body)?.[1] || "inscribed file";
  const mime = /^data:([^;,]+)/i.exec(body)?.[1] || "application/octet-stream";
  const dl = safeDataUrl(body, /^data:[^,]+;base64,[a-z0-9+/]+=*$/i)
    ? `<a class="key" download="${escapeMarkup(decodeURIComponent(name))}" href="${body}">DOWNLOAD FILE</a>`
    : `<div class="dim">file too large to preview, view on explorer</div>`;
  return `<div class="v-file"><div>${escapeMarkup(decodeURIComponent(name))}</div><div class="dim">${escapeMarkup(mime)}</div>${dl}</div>`;
}

function tokenScreen(body: string): string {
  let t: Record<string, unknown> = {};
  try { t = (JSON.parse(body) || {}) as Record<string, unknown>; } catch { /* keep empty */ }
  const sym = escapeMarkup(String(t.symbol || "?"));
  const name = escapeMarkup(String(t.name || ""));
  const mint = escapeMarkup(String(t.mint || ""));
  return `<div class="v-coin"><div class="v-sym">$${sym}</div><div class="dim">${name}</div><div class="dim">${mint}</div></div>`;
}

function nftScreen(meta: Record<string, unknown>): string {
  const image = typeof meta.image === "string" && /^https?:\/\//i.test(meta.image)
    ? `<img class="v-nftimg" alt="nft" src="${escapeMarkup(meta.image)}">` : "";
  const name = escapeMarkup(String(meta.name || ""));
  const sub = [meta.symbol ? `$${escapeMarkup(String(meta.symbol))}` : "", meta.description ? escapeMarkup(String(meta.description)) : ""].filter(Boolean).join(" / ");
  const attrs = Array.isArray(meta.attributes)
    ? (meta.attributes as Array<Record<string, unknown>>)
        .filter((a) => a && a.trait_type != null)
        .map((a) => `<div class="v-attr"><span class="dim">${escapeMarkup(String(a.trait_type)).toUpperCase()}</span><span>${escapeMarkup(String(a.value))}</span></div>`)
        .join("")
    : "";
  return `<div class="v-nft">${image}<div><div>${name}</div><div class="dim">${sub}</div>${attrs ? `<div class="v-attrs">${attrs}</div>` : ""}</div></div>`;
}

export const textScreen = (text: string): string =>
  isPreformattedText(text) ? `<pre>${escapeMarkup(text)}</pre>` : `<div class="v-text">${escapeMarkup(text)}</div>`;

function screenFor(sig: string, baseUrl: string, buf: Buffer): Screen {
  const size = humanSize(buf.length);

  // raw, standalone image bytes
  if (detectImageType(buf)) return { kind: "IMAGE", size, who: "-", top: false, html: imgScreen(baseUrl, sig) };

  // code-in {kind,body,who} record
  const rec = parseRecord(buf);
  if (rec) {
    const who = rec.who ? shortId(String(rec.who)) : "-";
    const body = typeof rec.body === "string" ? rec.body : "";
    const kind = String(rec.kind || "text").toLowerCase();
    if (kind === "image" || /^data:image\//i.test(body)) return { kind: "IMAGE", size, who, top: false, html: imgScreen(baseUrl, sig) };
    if (kind === "audio" || /^data:audio\//i.test(body)) return { kind: "AUDIO", size, who, top: false, html: audioScreen(body, who) };
    if (kind === "file" && /^data:/i.test(body)) return { kind: "FILE", size, who, top: false, html: fileScreen(body) };
    if (kind === "token") return { kind: "TOKEN", size, who, top: false, html: tokenScreen(body) };
    if (kind === "ascii") return { kind: "ASCII", size, who, top: true, html: `<pre>${escapeMarkup(body)}</pre>` };
    return { kind: kind.toUpperCase(), size, who, top: true, html: textScreen(body) };
  }

  // not a record: NFT metadata json, generic json, or plain text
  const text = buf.toString("utf-8");
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && (Array.isArray((o as Record<string, unknown>).attributes) || (typeof (o as Record<string, unknown>).name === "string" && typeof (o as Record<string, unknown>).image === "string"))) {
      return { kind: "METADATA", size, who: "-", top: true, html: nftScreen(o as Record<string, unknown>) };
    }
    return { kind: "DATA", size, who: "-", top: true, html: `<pre>${escapeMarkup(JSON.stringify(o, null, 2))}</pre>` };
  } catch { /* not json */ }
  return { kind: isPreformattedText(text) ? "ASCII" : "TEXT", size, who: "-", top: !!text, html: textScreen(text) };
}

// ── the console shell (one template, content slots in) ───────────────────────
export function renderPage(sig: string, baseUrl: string, s: Screen, ogDesc: string): string {
  const shortSig = shortId(sig);
  const explorerTxUrl = `https://solscan.io/tx/${sig}`;
  const kindLower = s.kind.toLowerCase();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>IQLabs Inscription Console — ${escapeMarkup(shortSig)}</title>
<meta property="og:title" content="IQLabs Inscription"/>
<meta property="og:description" content="${escapeMarkup(ogDesc)}"/>
<meta property="og:image" content="${baseUrl}/render/${sig}?v=${RENDER_REVISION}"/>
<style>
@font-face{font-family:'UnifontEX';src:url('https://cdn.jsdelivr.net/gh/stgiga/UnifontEX@main/UnifontExMono.woff2') format('woff2'),url('https://cdn.jsdelivr.net/gh/stgiga/UnifontEX@main/UnifontExMono.woff') format('woff');font-display:swap}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{background:#070807;font-family:'UnifontEX','Unifont','GNU Unifont',monospace;font-size:16px;line-height:1.25;color:#bfe8bf;-webkit-font-smoothing:none;display:grid;grid-template-rows:minmax(0,1fr)}
.frame{width:100%;height:100%;min-height:0;display:grid;grid-template-rows:minmax(0,1fr);justify-items:center;align-items:center;padding:clamp(12px,2vw,28px);background:#070807;position:relative}
.well{width:auto;max-width:100%;height:auto;max-height:100%;min-height:0;min-width:0;display:grid;grid-template-rows:minmax(0,1fr);place-items:center}
.well .console{box-shadow:inset 1px 1px 0 #7a807a,inset -1px -1px 0 #000,0 8px 0 #000}
a{color:#7dff7f}a:hover{color:#d6ffd6}
button{font:inherit;color:inherit;cursor:pointer}
.console{width:auto;height:auto;max-width:100%;max-height:100%;min-height:0;min-width:0;background:linear-gradient(180deg,#3a3e3a 0%,#2b2e2b 60%,#232623 100%);border:3px solid;border-color:#5e635e #101110 #101110 #5e635e;padding:10px;display:grid;grid-template-columns:232px minmax(0,1fr) 232px;grid-template-rows:minmax(0,1fr);gap:10px}
.rail{display:grid;gap:8px;align-content:start;min-height:0}
.rail.left{grid-template-rows:auto auto auto auto minmax(0,1fr)}
.rail.right{grid-template-rows:auto auto auto minmax(0,1fr)}
.log{overflow:auto;align-content:start;min-height:0}
.log div{color:#3fc24c;word-break:break-word}.log div b{font-weight:normal;color:#5dff6a}
.lcd,.plate{color:#5dff6a;border:2px solid;border-color:#090a09 #4a4f4a #4a4f4a #090a09;text-shadow:0 0 4px rgba(93,255,106,.5);background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.25) 0 1px,transparent 1px 2px)}
.lcd{padding:6px 8px;display:grid;gap:2px}
.row{display:flex;justify-content:space-between;gap:8px;min-width:0}
.row span:first-child{color:#3fc24c;flex:0 0 auto}
.row span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.key,.badge{color:#e4f2e4;text-decoration:none;background:linear-gradient(#4a4f4a,#2e322e);border:2px solid;border-color:#6a706a #0f100f #0f100f #6a706a;box-shadow:0 2px 0 #000;display:block;text-align:center;padding:6px 8px}
.key:hover{color:#fff;background:linear-gradient(#565b56,#383c38)}
.key:active{border-color:#0f100f #6a706a #6a706a #0f100f;transform:translateY(2px);box-shadow:none}
.center{display:grid;grid-template-rows:minmax(0,1fr) auto;gap:8px;min-height:0;min-width:0}
.screen{min-width:min(700px,calc(100vw - 600px));min-height:min(560px,calc(100vh - 220px));background:#050705;border:3px solid;border-color:#090a09 #4a4f4a #4a4f4a #090a09;box-shadow:inset 0 0 28px rgba(0,0,0,.9);padding:clamp(12px,3vw,24px);overflow-x:hidden;overflow-y:auto;color:#41ff00;text-shadow:0 0 4px rgba(65,255,0,.5);background-image:repeating-linear-gradient(0deg,rgba(65,255,0,.05) 0 1px,transparent 1px 3px);display:flex;align-items:center;justify-content:center;container-type:inline-size}
.screen.top{align-items:flex-start;justify-content:flex-start}
.screen pre{font:inherit;color:inherit;white-space:pre-wrap;word-break:break-all;overflow-wrap:anywhere;max-width:100%}
.screen::-webkit-scrollbar,.log::-webkit-scrollbar{width:16px;height:16px}
.screen::-webkit-scrollbar-track,.log::-webkit-scrollbar-track{background:#0c1f0f;border-left:2px solid #090a09}
.screen::-webkit-scrollbar-thumb,.log::-webkit-scrollbar-thumb{background:linear-gradient(#4a4f4a,#2e322e);border:2px solid;border-color:#6a706a #0f100f #0f100f #6a706a}
.msgbar{display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
.msg{display:flex;align-items:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:36px}
.plate{height:64px;display:flex;align-items:center;justify-content:center;font-size:32px;padding:6px}
.plate-logo{height:46px;max-width:100%;object-fit:contain;filter:drop-shadow(0 0 6px rgba(65,255,0,.5))}
.led{width:10px;height:10px;background:#41ff00;box-shadow:0 0 6px #41ff00;display:inline-block;margin-right:8px;vertical-align:-1px}
.v-img{max-width:100%;max-height:100%;image-rendering:pixelated;border:2px solid #1f5a24;display:block}
.v-text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-width:60ch}
.dim{color:#3fc24c}
.v-file,.v-coin{display:grid;gap:12px;justify-items:center;text-align:center}
.v-sym{font-size:48px;line-height:1}
.v-nft{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;width:100%}
.v-nftimg{width:160px;height:160px;flex:0 0 auto;border:2px solid #1f5a24;image-rendering:pixelated}
.v-attrs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-top:12px}
.v-attr{display:flex;justify-content:space-between;gap:8px;border:2px solid #1f5a24;padding:4px 8px}
.deck{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;width:100%;max-width:640px;align-items:start}
.cover{width:160px;height:160px;border:2px solid #1f5a24;background:repeating-linear-gradient(45deg,#0c1f0f 0 6px,#071209 6px 12px);display:flex;align-items:flex-end;padding:6px;color:#3fc24c}
@container (max-width:480px){.deck{grid-template-columns:minmax(0,1fr)}.cover{width:128px;height:128px}}
@media (max-width:1265px){body{display:block}.frame{height:auto;padding:8px}.well{height:auto;width:100%}.console{height:auto;width:100%;grid-template-columns:minmax(0,1fr)}.screen{min-width:0;min-height:360px}.rail.right,.rail.left{grid-template-rows:none}.log{max-height:160px}}
</style>
</head>
<body>
<div class="frame">
<div class="well">
<div class="console">
  <div class="rail left">
    <div class="lcd">
      <div class="row"><span>KIND</span><span>${escapeMarkup(s.kind)}</span></div>
      <div class="row"><span>SIZE</span><span>${escapeMarkup(s.size)}</span></div>
      <div class="row"><span>SIG</span><span>${escapeMarkup(shortSig)}</span></div>
      <div class="row"><span>WHO</span><span>${escapeMarkup(s.who)}</span></div>
      <div class="row"><span>NET</span><span>SOLANA</span></div>
    </div>
    <button class="key" id="k-how">HOW TO CHECK MY DATA</button>
    <a class="key" href="${explorerTxUrl}" target="_blank" rel="noopener">VIEW ON EXPLORER</a>
    <button class="key" id="k-post">POST THIS</button>
  </div>

  <div class="center">
    <div class="screen${s.top ? " top" : ""}">${s.html}</div>
    <div class="msgbar"><div class="lcd msg" id="msg">&gt; inscribed on solana via iqlabs</div></div>
  </div>

  <div class="rail right">
    <div class="plate"><img class="plate-logo" src="${SOLANA_INTERNET_LOGO}" alt="Solana Internet"/></div>
    <div class="lcd"><div class="row"><span><span class="led"></span>ON-CHAIN</span><span>OK</span></div><div class="row"><span>VIEWER</span><span>v2</span></div></div>
    <div class="badge">SOL INTERNET</div>
    <div class="lcd log">
      <div><b>&gt;</b> fetch tx ${escapeMarkup(shortSig)} via rpc</div>
      <div><b>&gt;</b> signer ${escapeMarkup(s.who)}</div>
      <div><b>&gt;</b> decode body: ${escapeMarkup(s.size)}, kind=${escapeMarkup(kindLower)}</div>
      <div><b>&gt;</b> render ok</div>
    </div>
  </div>
</div>
</div>
</div>
<script>
(function(){
  var msg=document.getElementById('msg'),DEF=msg.textContent;
  var how=document.getElementById('k-how');
  if(how)how.onclick=function(){msg.textContent=msg.textContent.indexOf('fetch tx by sig')>=0?DEF:'> fetch tx by sig from any rpc, decode the body with the IQ SDK. no http.';};
  var post=document.getElementById('k-post');
  if(post)post.onclick=function(){if(navigator.clipboard)navigator.clipboard.writeText(location.href).then(function(){msg.textContent='> link copied. post it anywhere.';},function(){msg.textContent='> '+location.href;});else msg.textContent='> '+location.href;};
})();
</script>
</body>
</html>`;
}

viewRouter.get("/:sig", async (c) => {
  let sig = c.req.param("sig");
  for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".html", ".json", ".txt"]) {
    if (sig.endsWith(ext)) { sig = sig.slice(0, -ext.length); break; }
  }
  if (!sig || sig.length < 80) return c.text("invalid signature", 400);

  const cacheKey = `view:${sig}`;
  let buf = imageCache.get(cacheKey);
  if (!buf) {
    const disk = await getDiskCache("view", sig);
    if (disk) { buf = disk; imageCache.set(cacheKey, buf, TTL.IMAGE); }
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

  const proto = c.req.header("X-Forwarded-Proto") || "https";
  const host = c.req.header("Host") || "gateway.iqlabs.dev";
  const baseUrl = `${proto}://${host}${process.env.BASE_PATH || ""}`;

  const screen = screenFor(sig, baseUrl, buf);
  const ogDesc = screen.kind === "TEXT" || screen.kind === "ASCII"
    ? buf.toString("utf-8").slice(0, 160)
    : `${screen.kind.toLowerCase()} inscription, on-chain via iqlabs`;
  const html = renderPage(sig, baseUrl, screen, ogDesc);

  const etag = generateETag(html);
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  return c.html(html, 200, { "Cache-Control": "public, max-age=300, must-revalidate", ETag: etag });
});
