# IQ Gateway

A read-only HTTP cache for on-chain data stored on Solana via IQ Labs. Fetches data from the blockchain and serves it over HTTP with multi-tier caching. Anyone can run their own gateway.

## Why Run Your Own?

- **No single point of failure** - if one gateway goes down, spin up another
- **Your own cache** - faster for your users, your region
- **Data is always recoverable** - everything lives on Solana, any gateway can serve it
- **No vendor lock-in** - switch gateways anytime, same data

## Quick Start

```bash
git clone https://github.com/IQCoreTeam/iq-gateway.git
cd iq-gateway
bun install
cp .env.example .env
```

Edit `.env`:
```
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
PORT=3000
```

Run:
```bash
bun run dev
```

That's it. Your gateway is live at `http://localhost:3000`.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_CLUSTER` | Yes | `devnet`, `mainnet-beta`, or `testnet` |
| `SOLANA_RPC_ENDPOINT` | Yes | Solana RPC URL (must match cluster) |
| `HELIUS_API_KEY` | No | Helius API key for faster reads (paid plan enables gTFA + batch) |
| `HELIUS_API_KEYS` | No | Comma-separated Helius keys for 429 fallback (overrides `HELIUS_API_KEY`) |
| `BACKFILL_FROM_SLOT` | No | Start slot for historical backfill (requires paid Helius). Set to `398615411` for full IQ Labs history |
| `PORT` | No | Server port (default: 3000) |
| `BASE_PATH` | No | URL prefix if behind reverse proxy |
| `MAX_CACHE_SIZE` | No | Max disk cache before cleanup (default: 10GB) |

## Endpoints

### Assets & Metadata

| Endpoint | Description |
|----------|-------------|
| `GET /meta/{sig}.json` | Metaplex-compatible JSON metadata |
| `GET /img/{sig}.png` | Raw image/file bytes |
| `GET /data/{sig}` | Raw asset data |
| `GET /view/{sig}` | Rendered HTML view of text inscriptions |
| `GET /render/{sig}` | PNG/SVG render of text inscriptions |

### Tables (On-Chain Database)

| Endpoint | Description |
|----------|-------------|
| `GET /table/{pda}/rows` | Read table rows with pagination. Supports `If-None-Match` -> `304 Not Modified` via weak ETag. Rows include `__txSignature`, `__signer` (fee payer), and `__blockTime` (chain-truth timestamp). Head-page refresh is gated by table meta `lastTimestamp` so unchanged tables avoid extra signature scans. |
| `GET /table/{pda}/index` | Full signature index for a table |
| `GET /table/{pda}/slice` | Read specific rows by signature |
| `GET /table/{pda}/meta` | Table metadata (name, columns, `lastTimestamp`, gate config) |
| `POST /table/{pda}/notify` | Notify about a new tx for instant cache injection. Also pushes to open SSE streams. |
| `GET /table/{pda}/subscribe` | **Server-Sent Events stream.** Emits `event: hello` on connect, `event: row` on each `/notify`, `event: ping` every 30s. Clients use `new EventSource(...)` instead of polling. |
| `GET /table/{feedPda}/thread/{threadPda}` | Resolved `{op, replies, totalReplies}` in one call. Server-side OP picker (prefers row with `sub`, tiebreak earliest time) removes the two-fetch + client-side OP-resolution pattern. |
| `GET /table/dbroot` | DB root info (tables, creators) |
| `GET /table/cache/stats` | Cache statistics |

### Users

| Endpoint | Description |
|----------|-------------|
| `GET /user/{pubkey}/assets` | List assets uploaded by a wallet |
| `GET /user/{pubkey}/sessions` | List user sessions |
| `GET /user/{pubkey}/profile` | User profile data |
| `GET /user/{pubkey}/state` | Raw user state account |
| `GET /user/{pubkey}/connections` | User connections |
| `GET /user/{pubkey}/posts` | Signatures this wallet has authored. **Opportunistic index** — populated at decode time, so coverage grows as the gateway serves traffic. `{pubkey, signatures, count, note}`. |

### Gate Verification

| Endpoint | Description |
|----------|-------------|
| `GET /gate/{tablePda}/check/{wallet}` | Server-side token-gate check. Returns `{sol, gate, tokenBalance, meetsGate, minSol}`. Replaces the client's `getBalance` + `getAccount` calls for gated-board UX. Cached 30 s. |

### API Docs

| Endpoint | Description |
|----------|-------------|
| `GET /openapi.json` | OpenAPI 3.0 schema for every endpoint |
| `GET /docs` | Interactive Swagger UI with gateway-hosted assets |

### Site Hosting (Solana Permanent Web)

| Endpoint | Description |
|----------|-------------|
| `GET /site/{manifestSig}` | Serve a website from Solana (index.html) |
| `GET /site/{manifestSig}/{path}` | Serve any file from an on-chain manifest |
| `GET /site/{manifestSig}/manifest` | Return the normalized manifest as JSON (`{manifestSig, indexPath, files}`). For clients that want to render sites themselves instead of consuming the served HTML. |

Supports both Iqoogle and gateway manifest formats. SPA fallback for unknown paths. Root-relative asset requests (e.g. `/logo.webp`) are resolved against the active manifest.

Deploy a site:
```bash
bun run scripts/deploy-site.ts ./my-site ./keypair.json
```

### Cache (peer bootstrap)

| Endpoint | Description |
|----------|-------------|
| `GET /cache/info` | Entry count, total size, by-type breakdown |
| `GET /cache/entries` | Paginated disk-cache entry index. Supports `type`, indexed `q` (3-256 chars), `limit`, and opaque `cursor`. |
| `GET /cache/entries/{id}` | One disk-cache entry with a bounded decoded preview when possible. |
| `GET /cache/blob/{id}` | Raw cached bytes for a disk-cache entry. |
| `GET /cache/memory` | Process-local memory-cache counts, or paginated searchable keys/previews with `cache=<name>&q=<text>&includeValues=true`. Memory clears on restart; value-preview pages are capped lower than key-only pages. |
| `GET /cache/snapshot` | Streamed `tar.gz` of the full cache (cache.db + blob dirs). VACUUM-INTO consistent. Public read; lets a cold gateway warm up from a hot peer without re-fetching every entry from chain. See [Cache Snapshot](#cache-snapshot) below. |

### System

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check + cache stats |
| `GET /version` | Server version info |
| `GET /` | Terminal-styled homepage with live stats |

## Caching

Three-tier cache with different TTLs:

| Layer | TTL | Purpose |
|-------|-----|---------|
| Memory (LRU) | 60s head, 5min other | Fast reads |
| Disk (SQLite) | 5min rows, 24h immutable | Persistent across restarts |
| Chain (Solana) | Permanent | Source of truth |

Rows head pages use the table account's `lastTimestamp` as a cheap change
gate. If the timestamp is unchanged, the gateway can keep serving the cached
head page; if it changed, the background refresh catches up new signatures and
stamps the fresh timestamp once the indexed signature list overlaps the cache.

Individual rows are cached for 24 hours (on-chain data is immutable). Head page responses are cached for 60 seconds with throttled background refresh.

## Helius Integration

With a paid Helius plan (`HELIUS_API_KEY`), the gateway automatically uses:

- **gTFA** (`getTransactionsForAddress`) — 100 full transactions per call, ~100x faster reads for session files
- **Batch JSON-RPC** — multiple `getTransaction` calls in one POST for table row reads
- **Backfill** — pre-cache all historical IQ Labs transactions on startup (set `BACKFILL_FROM_SLOT`)

Without Helius, everything still works using standard Solana RPC — just slower for large files.

## Deployment

### VPS / Bare Metal

1. Build and run with Docker:
```bash
docker build -t iq-gateway .
docker run -d \
  -p 3000:3000 \
  -v iq-cache:/app/cache \
  --env-file .env \
  --restart unless-stopped \
  iq-gateway
```

2. Put it behind a reverse proxy (nginx, caddy, etc.) for SSL:
```nginx
server {
    listen 443 ssl;
    server_name gateway.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

3. Point DNS:
```
Type:  A
Name:  gateway
Value: <your-server-ip>
```

### Akash (Decentralized)

1. Create an SDL file (`deploy.yaml`):
```yaml
---
version: "2.0"
services:
  gateway:
    image: ghcr.io/iqcoreteam/iq-gateway:latest
    expose:
      - port: 3000
        as: 80
        accept:
          - gateway.yourdomain.com
        to:
          - global: true
    env:
      - SOLANA_CLUSTER=mainnet-beta
      - SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
      - PORT=3000
    params:
      storage:
        cache:
          mount: /app/cache
          readOnly: false
profiles:
  compute:
    gateway:
      resources:
        cpu:
          units: 2
        memory:
          size: 2Gi
        storage:
          - size: 1Gi
          - name: cache
            size: 10Gi
            attributes:
              persistent: true
              class: beta3
  placement:
    dcloud:
      pricing:
        gateway:
          denom: uakt
          amount: 100000
deployment:
  gateway:
    dcloud:
      profile: gateway
      count: 1
```

2. Deploy via [Akash Console](https://console.akash.network) or CLI

3. Point DNS to the ingress URI Akash gives you:
```
Type:   CNAME
Name:   gateway
Value:  <your-deployment>.ingress.akashprovid.com
```

The `accept` field in the SDL tells the Akash provider to route traffic for your domain to the container.

## Cache Snapshot

Public read-only snapshot of the gateway's disk cache so a cold peer can bootstrap from a hot one without re-fetching every entry from Solana. The snapshot streams `tar -czf -` directly — first byte arrives quickly even for large caches, and Cloudflare's 100s edge timeout doesn't bite.

### Local bootstrap

```bash
# warm a cold gateway from a peer's hot cache
./scripts/bootstrap-cache-from-peer.sh https://gateway.solanainternet.com ./cache
# then start (or restart) your gateway
```

### Kubernetes bootstrap

For a deployment whose `/app/cache` is mounted from a PVC, the script handles the full safe restore — scale the deployment to 0, wipe the PVC via a temp pod, untar the peer snapshot, verify the row count, scale back up:

```bash
./scripts/bootstrap-cache-from-peer.sh --k8s https://gateway.solanainternet.com iqlabs gateway
```

### Or inline

```bash
curl -sS https://peer-gateway/cache/snapshot | tar -xz -C ./cache
```

| Endpoint | Description |
|---|---|
| `GET /cache/info` | entry count + total size + by-type breakdown |
| `GET /cache/entries` | paginated disk-cache entry index for external explorers; `q` is indexed and requires 3-256 chars |
| `GET /cache/entries/{id}` | one disk-cache entry with metadata + bounded preview |
| `GET /cache/blob/{id}` | raw cached bytes for an entry |
| `GET /cache/memory` | process-local memory-cache counts, searchable keys, and optional bounded previews |
| `GET /cache/snapshot` | streamed `tar.gz` of the full cache (cache.db + blob dirs). VACUUM-INTO consistent. public read. |

The gateway is read-only by design — no `POST /cache/restore` or `/sync-from-peer`. Operators write to their own cache directory directly (filesystem op on their own host); they don't write across the network.

The explorer endpoints are intentionally paginated/read-only so a separate site
can browse cache contents without asking the gateway to dump a multi-GB cache as
one JSON response. Responses use opaque entry ids and never expose the local
cache filesystem path. Disk previews are byte-bounded; memory value previews are
smaller and process-local because memory cache is only the current gateway
process state.

## Architecture

The gateway is a read-only cache layer. It never writes to Solana. All data is public and recoverable from chain. Multiple gateways can serve the same data independently.

## SNS / sol.site integration

The gateway resolves Solana Name Service (SNS) domains to on-chain IQ manifests at request time. One URL record on a `.sol` domain powers three browser surfaces — no server-side coordination required.

### the one record

On your `.sol` domain via [sns.id](https://www.sns.id), set:

```
Record.URL = https://gateway.iqlabs.dev/site/<your-sig>/<your-index-file>
```

Per the SNS web-resolution spec, the URL record is the canonical "this is my website" pointer. Brave's native `.sol` resolver and sol-domain.org check it first.

### what works after one record

| URL | How it resolves |
|---|---|
| `gateway.iqlabs.dev/sns/<name>` | Reads the URL record on-chain, 302s to `/site/<sig>/<file>` |
| `<name>.sol` (in Brave with SNS resolution enabled) | Brave reads the URL record, navigates there |
| `<name>.sol.site/<file>` | Requires a CNAME alongside (see below) |

### path-based access

```bash
$ curl -L https://gateway.iqlabs.dev/sns/<your-name>
# → 302 → /site/<sig>/<your-index-file> → on-chain content
```

The resolver accepts the domain bare (`/sns/nubs`) or with the `.sol` / `.sol.site` suffix.

### host-based access (`*.sol.site`)

For the prettier `<name>.sol.site` URL, also set a CNAME via the "Configure Sol.site" UI on sns.id:

```
Record.CNAME = sns.iqlabs.dev
```

`sns.iqlabs.dev` is a direct A record to the gateway origin (no Cloudflare proxy). Sol.site materialises the CNAME as DNS → traffic reaches the gateway → host middleware reads the URL record → manifest served.

### record value formats

The URL record can be:
- A full URL: `https://gateway.iqlabs.dev/site/<sig>/<file>` (recommended — works for Brave AND our gateway)
- A bare 86–90 char Solana tx signature (works for our gateway only)

The resolver also reads `Record.TXT` as a fallback.

### caching

Lookups are cached 5 minutes (memory + disk, both positive and negative). Concurrent cold-cache requests for the same domain are deduplicated so only one Solana RPC call fires.
