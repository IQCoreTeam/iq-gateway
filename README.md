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
| `GET /table/{pda}/rows` | Read table rows with pagination |
| `GET /table/{pda}/index` | Full signature index for a table |
| `GET /table/{pda}/slice` | Read specific rows by signature |
| `POST /table/{pda}/notify` | Notify about a new tx for instant cache injection |
| `GET /table/cache/stats` | Cache statistics |

### Users

| Endpoint | Description |
|----------|-------------|
| `GET /user/{pubkey}/assets` | List assets uploaded by a wallet |
| `GET /user/{pubkey}/sessions` | List user sessions |
| `GET /user/{pubkey}/profile` | User profile data |
| `GET /user/{pubkey}/state` | User state |
| `GET /user/{pubkey}/connections` | User connections |

### Site Hosting (Solana Permanent Web)

| Endpoint | Description |
|----------|-------------|
| `GET /site/{manifestSig}` | Serve a website from Solana (index.html) |
| `GET /site/{manifestSig}/{path}` | Serve any file from an on-chain manifest |

Supports both Iqoogle and gateway manifest formats. SPA fallback for unknown paths. Root-relative asset requests (e.g. `/logo.webp`) are resolved against the active manifest.

Deploy a site:
```bash
bun run scripts/deploy-site.ts ./my-site ./keypair.json
```

### System

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check + cache stats |
| `GET /version` | Server version info |

## Caching

Three-tier cache with different TTLs:

| Layer | TTL | Purpose |
|-------|-----|---------|
| Memory (LRU) | 60s head, 5min other | Fast reads |
| Disk (SQLite) | 5min rows, 24h immutable | Persistent across restarts |
| Chain (Solana) | Permanent | Source of truth |

Individual rows are cached for 24 hours (on-chain data is immutable). Head page responses are cached for 60 seconds with throttled background refresh.

## Docker

```bash
docker build -t iq-gateway .
docker run -p 3000:3000 --env-file .env iq-gateway
```

## Helius Integration

With a paid Helius plan (`HELIUS_API_KEY`), the gateway automatically uses:

- **gTFA** (`getTransactionsForAddress`) — 100 full transactions per call, ~100x faster reads for session files
- **Batch JSON-RPC** — multiple `getTransaction` calls in one POST for table row reads
- **Backfill** — pre-cache all historical IQ Labs transactions on startup (set `BACKFILL_FROM_SLOT`)

Without Helius, everything still works using standard Solana RPC — just slower for large files.

## Architecture

The gateway is a read-only cache layer. It never writes to Solana. All data is public and recoverable from chain. Multiple gateways can serve the same data independently.
