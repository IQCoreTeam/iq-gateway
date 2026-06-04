import type { Context } from "hono";
import { NETWORK, NETWORK_CONFIG } from "../../chain/evm";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iq eth gateway</title>
<style>
  body {
    margin: 0; background: #000; color: #d6ffd6;
    font-family: ui-monospace, "JetBrains Mono", monospace;
    font-size: 14px; line-height: 1.55; padding: 32px 24px 96px;
  }
  .wrap { max-width: 880px; margin: 0 auto; }
  pre.banner { color: #0aff0a; font-size: 11px; line-height: 1.2; margin: 0 0 8px; }
  .meta { color: #1f4028; font-size: 12px; margin-bottom: 28px; }
  .meta a { color: #0aff0a; }
  h2 { margin: 36px 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.1em;
       color: #0aff0a; border-bottom: 1px dashed rgba(10, 255, 10, 0.18); padding-bottom: 6px; }
  a { color: #0aff0a; }
  code { color: #0aff0a; }
  table.kv { border-collapse: collapse; margin: 8px 0 16px; width: 100%; }
  table.kv td { padding: 4px 12px 4px 0; border-bottom: 1px dotted rgba(10, 255, 10, 0.18); }
  table.kv td:first-child { color: #4a8b5e; width: 200px; }
  .ep { margin: 6px 0; }
  .ep code:first-child { display: inline-block; min-width: 320px; color: #d6ffd6; }
  .ep .desc { color: #4a8b5e; }
  .pre-code { background: #050505; border-left: 2px solid #0aff0a; padding: 12px 14px; margin: 12px 0; }
  footer { margin-top: 64px; padding-top: 16px; border-top: 1px dashed rgba(10, 255, 10, 0.18); color: #1f4028; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
<pre class="banner">    _____ ____    _____ _   _   _    _____      _
   |_   _/ __ \\  / ____| | | | | |  / ____|    | |
     | || |  | || |  __| |_| |_| |_| |  __  __ _| |_ _____      ____ _ _   _
     | || |  | || | |_ |_   _|_   _| | |_ |/ _\` | __/ _ \\ \\ /\\ / / _\` | | | |
    _| || |__| || |__| | |_|   |_| | |__| | (_| | ||  __/\\ V  V / (_| | |_| |
   |_____\\____/  \\_____|         |_|\\_____|\\__,_|\\__\\___| \\_/\\_/ \\__,_|\\__, |
                                                                       __/ |
                                                                      |___/ </pre>
<div class="meta">
  read-only http cache for EVM on-chain content
  &middot; <span id="ver">loading…</span>
  &middot; <a href="/docs">/docs</a>
  &middot; <a href="/openapi.json">/openapi.json</a>
  &middot; <a href="/health">/health</a>
</div>

<h2>$ what this is</h2>
<p>iq-eth-gateway resolves IQ Labs on-chain content from EVM chains and serves it over HTTP with a multi-tier cache. EVM sibling of <a href="https://github.com/IQCoreTeam/iq-gateway">iq-gateway</a>. Anyone can run their own; data is recoverable from chain so any gateway can serve any tx hash.</p>

<h2>$ live state</h2>
<table class="kv">
  <tr><td>network</td><td>${NETWORK} (chain ${NETWORK_CONFIG.chainId})</td></tr>
  <tr><td>currency</td><td>${NETWORK_CONFIG.currency}</td></tr>
  <tr><td>contract</td><td><code>${NETWORK_CONFIG.contractAddress}</code></td></tr>
  <tr><td>uptime</td><td id="uptime">loading…</td></tr>
  <tr><td>alchemy</td><td id="alchemy">loading…</td></tr>
  <tr><td>rpc calls</td><td id="rpc">loading…</td></tr>
  <tr><td>cache entries</td><td id="entries">loading…</td></tr>
  <tr><td>cache size</td><td id="cachesize">loading…</td></tr>
</table>

<h2>$ endpoints (excerpt)</h2>
<div class="ep"><code>GET /data/{txHash}</code><span class="desc">raw asset data + metadata</span></div>
<div class="ep"><code>GET /meta/{txHash}.json</code><span class="desc">metaplex-compatible metadata</span></div>
<div class="ep"><code>GET /img/{txHash}.png</code><span class="desc">raw image bytes</span></div>
<div class="ep"><code>GET /view/{txHash}</code><span class="desc">html render of text inscription</span></div>
<div class="ep"><code>GET /render/{txHash}</code><span class="desc">png/svg render</span></div>
<div class="ep"><code>GET /table/{dbRootId}/{tableName}/rows</code><span class="desc">paginated rows; ETag 304</span></div>
<div class="ep"><code>GET /table/{dbRootId}/{tableName}/subscribe</code><span class="desc">SSE: hello / row / ping</span></div>
<div class="ep"><code>POST /table/{dbRootId}/{tableName}/notify</code><span class="desc">warm cache + push SSE</span></div>
<div class="ep"><code>GET /user/{addr}/{assets,profile,state,connections,posts}</code><span class="desc">per-wallet views</span></div>
<div class="ep"><code>GET /gate/{dbRootId}/{tableName}/check/{wallet}</code><span class="desc">ERC-20/ERC-721 gate check</span></div>
<div class="ep"><code>GET /ens/{name}</code><span class="desc">ENS forward / reverse</span></div>
<div class="ep"><code>GET /dbroots</code><span class="desc">list known dbRoots</span></div>
<div class="ep"><code>GET /cache/{info,entries,memory,snapshot}</code><span class="desc">cache APIs</span></div>
<p>full schema at <a href="/openapi.json">/openapi.json</a> &middot; interactive at <a href="/docs">/docs</a></p>

<h2>$ run your own gateway</h2>
<div class="pre-code">git clone &lt;repo&gt;
cd iq-eth-gateway
bun install
cp .env.example .env
# set IQETH_NETWORK + IQETH_RPC_ENDPOINT
bun run dev</div>

<footer>
  built by <a href="https://github.com/IQCoreTeam">IQ Labs</a> &middot; Apache License
</footer>
</div>
<script>
(async () => {
  const fmt = (n) => n < 1024 ? n+" B" : n < 1048576 ? (n/1024).toFixed(1)+" KB" : (n/1048576).toFixed(1)+" MB";
  const fmtUp = (s) => { s = Math.floor(s); const d=Math.floor(s/86400); s-=d*86400; const h=Math.floor(s/3600); s-=h*3600; const m=Math.floor(s/60); return (d?d+"d ":"")+h+"h "+m+"m"; };
  try {
    const h = await fetch('/health').then(r=>r.json());
    document.getElementById('uptime').textContent = fmtUp(h.uptime || 0);
    document.getElementById('alchemy').textContent = h.rpc?.alchemyEnabled ? "enabled" : "disabled";
    document.getElementById('rpc').textContent = (h.rpc?.totalCalls ?? "?") + " total / " + (h.rpc?.errors ?? 0) + " err";
  } catch (e) {}
  try {
    const v = await fetch('/version').then(r=>r.json());
    document.getElementById('ver').textContent = "v" + (v.version || "?");
  } catch (e) {}
  try {
    const c = await fetch('/cache/info').then(r=>r.json());
    document.getElementById('entries').textContent = (c.entries ?? 0).toLocaleString();
    document.getElementById('cachesize').textContent = fmt(c.totalSize ?? 0);
  } catch (e) {}
})();
</script>
</body>
</html>`;

export function homeHandler(c: Context) {
  return c.html(HTML);
}
