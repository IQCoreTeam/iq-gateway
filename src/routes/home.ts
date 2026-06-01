// GET / — the gateway homepage. Server-rendered HTML, terminal-flavored,
// minimal JS for live-stat hydration. No external deps.

import type { Context } from "hono";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iq labs gateway</title>
<style>
  :root {
    --bg: #000;
    --bg-alt: #050505;
    --fg: #d6ffd6;
    --fg-mute: #4a8b5e;
    --fg-faint: #1f4028;
    --green: #0aff0a;
    --green-dim: #06b806;
    --red: #ff5555;
    --rule: rgba(10, 255, 10, 0.18);
    --glow: 0 0 5px #0aff0a;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: ui-monospace, "JetBrains Mono", "SF Mono", "DejaVu Sans Mono", Menlo, monospace;
    font-size: 14px;
    line-height: 1.55;
    padding: 32px 24px 96px;
  }
  .wrap { max-width: 880px; margin: 0 auto; }

  pre.banner {
    color: var(--green);
    text-shadow: var(--glow);
    font-size: 11px;
    line-height: 1.2;
    margin: 0 0 8px;
    overflow-x: auto;
  }
  .meta { color: var(--fg-faint); font-size: 12px; margin-bottom: 28px; }
  .meta a { color: var(--green); text-decoration: none; }
  .meta a:hover { text-decoration: underline; }

  h2 {
    margin: 36px 0 8px;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--green);
    text-shadow: var(--glow);
    border-bottom: 1px dashed var(--rule);
    padding-bottom: 6px;
    font-weight: 600;
  }
  h2 .num { color: var(--fg-faint); margin-right: 8px; }

  p { margin: 8px 0 12px; max-width: 720px; }
  p strong { color: var(--green); font-weight: 600; }
  a { color: var(--green); text-decoration: underline; text-decoration-color: var(--rule); }
  a:hover { text-decoration-color: var(--green); }
  code { color: var(--green); }

  table.kv {
    border-collapse: collapse;
    margin: 8px 0 16px;
    width: 100%;
    max-width: 720px;
  }
  table.kv td {
    padding: 4px 12px 4px 0;
    border-bottom: 1px dotted var(--rule);
    vertical-align: top;
  }
  table.kv td:first-child {
    color: var(--fg-mute);
    width: 200px;
    white-space: nowrap;
  }
  table.kv td:last-child { color: var(--fg); }
  table.kv td.live { color: var(--green); font-variant-numeric: tabular-nums; }

  .ep { margin: 6px 0; }
  .ep code:first-child { display: inline-block; min-width: 280px; color: var(--fg); }
  .ep .desc { color: var(--fg-mute); }

  .pre-code {
    background: var(--bg-alt);
    border: 1px solid var(--rule);
    border-left: 2px solid var(--green);
    padding: 12px 14px;
    margin: 12px 0;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg);
  }

  ul.tight { margin: 8px 0; padding-left: 20px; }
  ul.tight li { margin: 4px 0; color: var(--fg-mute); }
  ul.tight li code { color: var(--green); }

  footer {
    margin-top: 64px;
    padding-top: 16px;
    border-top: 1px dashed var(--rule);
    color: var(--fg-faint);
    font-size: 12px;
  }
  footer a { color: var(--fg-mute); }

  .ok { color: var(--green); }
  .err { color: var(--red); }
  .pending { color: var(--fg-faint); }
</style>
</head>
<body>
<div class="wrap">

<pre class="banner">    _____ ____    _____      _                           
   |_   _/ __ \\  / ____|    | |                          
     | || |  | || |  __ __ _| |_ _____      ____ _ _   _ 
     | || |  | || | |_ |/ _\` | __/ _ \\ \\ /\\ / / _\` | | | |
    _| || |__| || |__| | (_| | ||  __/\\ V  V / (_| | |_| |
   |_____\\____/  \\_____|\\__,_|\\__\\___| \\_/\\_/ \\__,_|\\__, |
                                                     __/ |
                                                    |___/ </pre>

<div class="meta">
  read-only http cache for solana-permanent-web content
  &middot; <span id="ver">loading…</span>
  &middot; <a href="/docs">/docs</a>
  &middot; <a href="/openapi.json">/openapi.json</a>
  &middot; <a href="/health">/health</a>
  &middot; <a href="https://github.com/IQCoreTeam/iq-gateway">github</a>
</div>

<h2><span class="num">$</span> what this is</h2>
<p>
  IQ Gateway resolves Solana on-chain content (manifests, table rows, signatures, SNS records) and serves it over HTTP with a multi-tier cache. Anyone can run their own; data is recoverable from chain so any gateway can serve any sig. This deployment is one of multiple cooperating instances.
</p>

<h2><span class="num">$</span> live state</h2>
<table class="kv">
  <tr><td>cluster</td><td class="live" id="cluster">loading…</td></tr>
  <tr><td>uptime</td><td class="live" id="uptime">loading…</td></tr>
  <tr><td>helius</td><td class="live" id="helius">loading…</td></tr>
  <tr><td>rpc calls</td><td class="live" id="rpc">loading…</td></tr>
  <tr><td>cache entries</td><td class="live" id="entries">loading…</td></tr>
  <tr><td>cache size</td><td class="live" id="cachesize">loading…</td></tr>
</table>

<h2><span class="num">$</span> sns &amp; sol.site</h2>
<p>
  Set one record on your <code>.sol</code> via <a href="https://www.sns.id">sns.id</a> &mdash; a URL record pointing at this gateway &mdash; and your domain becomes browsable in three places:
</p>
<div class="ep"><code>&lt;your-name&gt;.sol</code> <span class="desc">in Brave with native SNS resolution enabled</span></div>
<div class="ep"><code>&lt;your-name&gt;.sol.site/file</code> <span class="desc">any browser, via sol.site DNS materialisation</span></div>
<div class="ep"><code>${"${0}"}/sns/&lt;name&gt;</code> <span class="desc">any browser, via this gateway directly</span></div>
<p>The on-chain content is the same across all three. See <a href="https://github.com/IQCoreTeam/iq-gateway/blob/main/HOW-IT-WORKS.md">HOW-IT-WORKS.md</a> for the full spec + the SDK quirk we work around.</p>

<h2><span class="num">$</span> endpoints (excerpt)</h2>
<div class="ep"><code>GET /sns/{domain}</code><span class="desc">resolve sns → 302 to /site/&lt;sig&gt;/</span></div>
<div class="ep"><code>GET /sns/{domain}/{path}</code><span class="desc">drill into a specific file</span></div>
<div class="ep"><code>GET /site/{sig}</code><span class="desc">serve the manifest's index</span></div>
<div class="ep"><code>GET /site/{sig}/{path}</code><span class="desc">serve a file from the manifest</span></div>
<div class="ep"><code>GET /meta/{sig}.json</code><span class="desc">metaplex-compatible json metadata</span></div>
<div class="ep"><code>GET /img/{sig}.png</code><span class="desc">raw image bytes</span></div>
<div class="ep"><code>GET /data/{sig}</code><span class="desc">raw asset data</span></div>
<div class="ep"><code>GET /view/{sig}</code><span class="desc">rendered html view of a text inscription</span></div>
<div class="ep"><code>GET /render/{sig}</code><span class="desc">png/svg render of a text inscription</span></div>
<div class="ep"><code>GET /table/{pda}/rows</code><span class="desc">paginated rows; ETag 304 + timestamp-gated refresh</span></div>
<div class="ep"><code>GET /table/{pda}/subscribe</code><span class="desc">SSE: hello / row / ping every 30s</span></div>
<div class="ep"><code>GET /table/{feedPda}/thread/{threadPda}</code><span class="desc">resolved op + replies in one call</span></div>
<div class="ep"><code>GET /user/{pubkey}/posts</code><span class="desc">opportunistic signer index</span></div>
<div class="ep"><code>GET /user/{pubkey}/assets</code><span class="desc">assets uploaded by a wallet</span></div>
<div class="ep"><code>GET /gate/{tablePda}/check/{wallet}</code><span class="desc">server-side token-gate check</span></div>
<div class="ep"><code>GET /cache/info</code><span class="desc">cache stats — entries, size, by-type</span></div>
<div class="ep"><code>GET /cache/entries</code><span class="desc">paginated disk-cache index for explorers</span></div>
<div class="ep"><code>GET /cache/snapshot</code><span class="desc">streamed tar.gz of full cache (public; bootstrap a cold peer)</span></div>
<p>full schema at <a href="/openapi.json">/openapi.json</a> &middot; interactive at <a href="/docs">/docs</a></p>

<h2><span class="num">$</span> set sns to point here</h2>
<div class="pre-code">Record.URL = ${"${0}"}/site/&lt;your-sig&gt;/&lt;your-index-file&gt;</div>
<p>Pick the file path that matches your manifest's index (often <code>gameboy.html</code>, <code>index.html</code>, etc.). The sig in the URL value is the only thing the resolver needs &mdash; the rest is stripping fluff.</p>

<h2><span class="num">$</span> run your own gateway</h2>
<p>The whole stack is open source. Operator-agnostic by design: someone running their own instance pointed at the same chain serves the same content.</p>
<div class="pre-code">git clone https://github.com/IQCoreTeam/iq-gateway
cd iq-gateway
bun install
cp .env.example .env
# set SOLANA_CLUSTER=mainnet-beta + SOLANA_RPC_ENDPOINT
bun run dev</div>
<p>Containerized via the repo <code>Dockerfile</code> (chain-agnostic image; set <code>IQ_CHAIN</code> at runtime). To bootstrap a cold cache from a peer:</p>
<div class="pre-code">curl -H "X-Cache-Snapshot-Token: \$TOK" \\
     https://&lt;peer-gateway&gt;/cache/snapshot | tar -xz -C ./cache</div>
<p>Pulls the peer's full <code>cache.db</code> + blob dirs. Each entry is keyed by an on-chain identifier so you can verify any subset against chain. Skips the cold-start RPC storm.</p>

<h2><span class="num">$</span> caching</h2>
<table class="kv">
  <tr><td>memory (LRU)</td><td>500 entries, 5min TTL — hot path</td></tr>
  <tr><td>disk (sqlite)</td><td>10GB cap, evicts LRU when full — survives restarts</td></tr>
  <tr><td>chain (solana)</td><td>permanent — source of truth</td></tr>
</table>
<p>Negative results cached too (sentinel <code>__none__</code>) so junk lookups don't keep hitting RPC. In-flight dedup means N concurrent cold-cache requests for the same key share one upstream call.</p>

<footer>
  built by <a href="https://github.com/IQCoreTeam">IQ Labs</a>
  &middot; <a href="https://github.com/IQCoreTeam/iq-gateway">iq-gateway</a>
  &middot; <a href="https://github.com/NubsCarson">NubsCarson</a>

  &middot; <a href="https://github.com/IQCoreTeam/iq-gateway/blob/main/LICENSE">Apache License</a>
  &middot; <span id="commit">commit ?</span>
</footer>

</div>

<script>
(async () => {
  const fmt = (n) => {
    if (n < 1024) return n + " B";
    if (n < 1024*1024) return (n/1024).toFixed(1) + " KB";
    if (n < 1024*1024*1024) return (n/1024/1024).toFixed(1) + " MB";
    return (n/1024/1024/1024).toFixed(2) + " GB";
  };
  const fmtUp = (s) => {
    s = Math.floor(s/1000);
    const d = Math.floor(s/86400); s -= d*86400;
    const h = Math.floor(s/3600);  s -= h*3600;
    const m = Math.floor(s/60);
    return (d ? d+"d " : "") + h+"h "+m+"m";
  };
  try {
    const h = await fetch('/health').then(r=>r.json());
    document.getElementById('uptime').textContent = fmtUp(h.uptime || 0);
    document.getElementById('helius').textContent = h.rpc?.heliusEnabled ? "enabled" : "disabled";
    document.getElementById('rpc').textContent = (h.rpc?.totalCalls ?? "?") + " total / " + (h.rpc?.errors ?? 0) + " err";
  } catch (e) {}
  try {
    const v = await fetch('/version').then(r=>r.json());
    document.getElementById('ver').textContent = "v" + (v.version || "?") + (v.commit ? " · "+v.commit.slice(0,8) : "");
    if (v.commit) document.getElementById('commit').textContent = v.commit.slice(0,8);
  } catch (e) {}
  try {
    const c = await fetch('/cache/info').then(r=>r.json());
    document.getElementById('entries').textContent = (c.entries ?? 0).toLocaleString();
    document.getElementById('cachesize').textContent = fmt(c.totalSize ?? 0);
  } catch (e) {}
  try {
    const cluster = (await fetch('/health').then(r=>r.json()))?.cluster
                 || (location.host.includes('gateway') ? 'mainnet-beta' : '');
    document.getElementById('cluster').textContent = cluster || 'mainnet-beta';
  } catch (e) {}
  // template the gateway origin into the example blocks
  const origin = location.origin;
  document.body.innerHTML = document.body.innerHTML.replaceAll('${"${0}"}', origin);
})();
</script>

</body>
</html>`;

export function homeHandler(c: Context) {
  return c.html(HTML);
}
