# IQ Gateway

A read-only HTTP cache for IQ Labs on-chain data. Fetches from the blockchain and serves it over HTTP with multi-tier caching. Anyone can run their own gateway.

**One codebase, every chain.** By default one process serves Solana plus every
configured EVM network at once, with the chain picked per request. `IQ_CHAIN`
locks a process to a single chain when you want fault isolation:

- unset or `multi` (default): Solana + all EVM networks in one process. The
  resolver picks the chain per request from the id shape (base58 vs `0x`) or an
  explicit `?network=` query param.
- `IQ_CHAIN=solana`: Solana only (devnet / mainnet-beta / testnet) via [solana-sdk](https://www.npmjs.com/package/@iqlabs-official/solana-sdk)
- `IQ_CHAIN=evm`: one EVM network via [ethereum-sdk](https://www.npmjs.com/package/@iqlabs-official/ethereum-sdk)

Cache, RPC queue, ETag/304, SSE, and the server shell are shared. See
[Architecture](#architecture) and [Chains](#chains).

## Why Run Your Own?

- **No single point of failure** - if one gateway goes down, spin up another
- **Your own cache** - faster for your users, your region
- **Data is always recoverable** - everything lives on-chain, any gateway can serve it
- **No vendor lock-in** - switch gateways anytime, same data

## Quick Start

```bash
git clone https://github.com/IQCoreTeam/iq-gateway.git
cd iq-gateway
bun install
cp .env.example .env
```

**Solana** (`.env`):
```
IQ_CHAIN=solana
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
PORT=3000
```

**Multi-chain** (default; `.env`):
```
SOLANA_CLUSTER=mainnet-beta
SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
# optional per-network EVM RPC overrides; built-in defaults are used otherwise
# IQETH_RPC_MONAD=...
# IQETH_RPC_ROBINHOOD=...
PORT=3000
```

**Locked EVM** (`.env`):
```
IQ_CHAIN=evm
IQETH_NETWORK=sepolia                       # sepolia | monad | monadTestnet | robinhood
IQETH_RPC_ENDPOINT=https://rpc.sepolia.org
PORT=3000
```

Run:
```bash
bun run dev
```

That's it. Your gateway is live at `http://localhost:3000`.

## Chains

In the default multi mode the chain is resolved per request:

1. `?network=` wins (`solana`, `sepolia`, `monad`, `monadTestnet`, `robinhood`).
   An unknown value returns 400 with the valid list, never a silent wrong chain.
2. Otherwise the id shape decides: base58 32/64-byte ids route to Solana,
   everything else (a `0x` hash/address or an arbitrary dbRootId string) routes
   to the default EVM network (`IQETH_DEFAULT_NETWORK`, default `sepolia`).
3. Id-less routes (`/health`, `/dbroots`, `/table/dbroot`, ...) default to
   Solana unless `?network=` says otherwise.

Setting `IQ_CHAIN` locks a process to one chain instead (fault isolation; the
network within it comes from `SOLANA_CLUSTER` or `IQETH_NETWORK`).

| | Solana (`IQ_CHAIN=solana`) | EVM (`IQ_CHAIN=evm`) |
|---|---|---|
| tx identifier | `signature` (base58, 86–90) | `txHash` (`0x` + 64 hex) |
| wallet / account | base58 pubkey | `0x` 20-byte address |
| table key | table PDA — `/table/{pda}/…` | `dbRootId` + `tableName` — `/table/{dbRootId}/{tableName}/…` |
| row tx field | `__txSignature` | `__txHash` |
| name service | SNS (`/sns/…`, `*.sol.site`) | ENS (`/ens/…`) |
| token gate | SPL balance / ATA | ERC-20 / native balance |
| site hosting | `/site/…` (manifest) | — (not in v1) |
| fast reads | Helius (gTFA + batch) | Alchemy (batch + higher limits) |

**EVM networks:**

| Network | Chain ID | Gas | Contract |
|---|---|---|---|
| sepolia | 11155111 | ETH | 0x246A08D9fdD9b3990A88eD1f2DF1A87239839F07 |
| monad | 143 | MON | 0x7ae06f87Cf93606DA2BD6A281afB28028cAE233D |
| monadTestnet | 10143 | MON | 0x3379883538C068978e199472b5D127055c734867 |
| robinhood | 4663 | ETH | 0x88af59e58C7E5DcbE7cc12972B90cff3fEEF7223 |

## Configuration

**Shared**

| Variable | Required | Description |
|----------|----------|-------------|
| `IQ_CHAIN` | No | `solana` (default) or `evm` — selects the chain adapter + route set |
| `PORT` | No | Server port (default: 3000) |
| `BASE_PATH` | No | URL prefix if behind reverse proxy |
| `MAX_CACHE_SIZE` | No | Max disk cache before cleanup (default: 10GB) |
| `ADMIN_TOKEN` | No | Bearer token — enables `/admin/*` queue tuning when set |

**Solana** (`IQ_CHAIN=solana`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_CLUSTER` | Yes | `devnet`, `mainnet-beta`, or `testnet` |
| `SOLANA_RPC_ENDPOINT` | Yes | Solana RPC URL (must match cluster) |
| `HELIUS_API_KEY` | No | Helius API key for faster reads (paid plan enables gTFA + batch) |
| `HELIUS_API_KEYS` | No | Comma-separated Helius keys for 429 fallback (overrides `HELIUS_API_KEY`) |
| `BACKFILL_FROM_SLOT` | No | Start slot for historical backfill (requires paid Helius). Set to `398615411` for full IQ Labs history |

**EVM**

| Variable | Required | Description |
|----------|----------|-------------|
| `IQETH_NETWORK` | Locked mode only | `sepolia`, `monad`, `monadTestnet`, or `robinhood` (with `IQ_CHAIN=evm`) |
| `IQETH_RPC_ENDPOINT` | No | Single EVM JSON-RPC URL (chain ID validated at boot in locked mode) |
| `IQETH_RPC_<NET>` | No | Per-network RPC override in multi mode, e.g. `IQETH_RPC_MONAD`, `IQETH_RPC_ROBINHOOD`. Falls back to `IQETH_RPC_ENDPOINT`, then the built-in default |
| `IQETH_DEFAULT_NETWORK` | No | EVM network a bare `0x`/dbRootId request resolves to in multi mode (default `sepolia`) |
| `IQETH_DEPLOY_BLOCK_<NET>` | No | Contract deploy block per network; lets the row-index log backfill skip pre-deploy history |
| `IQETH_LOGS_SPAN` | No | Starting block span per `eth_getLogs` chunk for the log backfill (default 50000; halves automatically on RPC range errors) |
| `ALCHEMY_API_KEY` | No | Enables batched reads + higher rate limits |
| `ENS_RPC_ENDPOINT` | No | Mainnet RPC for ENS resolution (default `https://eth.llamarpc.com`) |
| `KNOWN_DBROOTS_FILE` | No | Seed file of dbRootIds for `/dbroots` discovery (default `./config/known-dbroots.json`) |

## Endpoints

Paths below use Solana identifiers (`{sig}`, `{pda}`). On `IQ_CHAIN=evm` the
shapes change: `{sig}` → `{txHash}` (`0x…`), and `{pda}` → `{dbRootId}/{tableName}`.
Two routes are **Solana-only** ([Site Hosting](#site-hosting-solana-permanent-web),
[SNS](#sns--solsite-integration)); one is **EVM-only** ([ENS](#ens-evm)). Everything
else exists on both chains. The live `/openapi.json` and `/docs` always reflect the
active chain.

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
| `GET /table/cache/stats` | Cache statistics (on EVM includes the durable row-index counters) |

**Durable EVM row index.** EVM has no `getSignaturesForAddress`, so enumerating
a table normally means a strictly sequential walk of `beforeDataTx` pointers
(one RPC round-trip per row, redone on cold cache). The gateway keeps a durable
SQLite index of every row-write tx per `(network, dbroot, table)`, fed by live
reads, `/notify`, and a background `eth_getLogs(DbCodeInEvent)` backfill that
scans the contract's indexed topics. Once a table is fully backfilled, deep
`before` pagination and `/index` are answered from SQLite in one query, and the
index also lists rows the pointer walk cannot reach (tails orphaned by the
two-tx `writeRow` race). Unlike the LRU blob cache this index is never pruned.
Operators can inspect or force a backfill via `GET/POST /admin/evm-index`
(requires `ADMIN_TOKEN`).

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

### ENS (EVM)

> **EVM only** (`IQ_CHAIN=evm`). Replaces the Solana [SNS](#sns--solsite-integration) routes. Uses a dedicated mainnet RPC (`ENS_RPC_ENDPOINT`), cached 30 min.

| Endpoint | Description |
|----------|-------------|
| `GET /ens/{name}` | Forward resolve an ENS name → `{name, address}`. If the segment is an address, reverse-resolves → `{address, name}`. |
| `GET /ens/{addr}/reverse` | Reverse resolve an address → primary ENS name `{address, name}`. |

### API Docs

| Endpoint | Description |
|----------|-------------|
| `GET /openapi.json` | OpenAPI 3.0 schema for every endpoint (active chain) |
| `GET /docs` | Interactive Swagger UI with gateway-hosted assets |

### Site Hosting (Solana Permanent Web)

> **Solana only.** No EVM equivalent in v1 (no on-chain manifest convention established for the EVM SDK yet).

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

### DbRoot Discovery

| Endpoint | Description |
|----------|-------------|
| `GET /dbroots` | Lists every DbRoot the iqlabs program owns, in one call. Uses `getProgramAccounts` with a memcmp filter on the Anchor DbRoot discriminator, so the response stays small (one row per dApp). Cached 30 min — DbRoots only mutate when a new dApp launches or a table is registered. Returns the raw DbRoot fields with no derivation: `{dbroots: [{pda, id, idHex, creator, tableCreators, extCreators, tableSeeds, globalTableSeeds}], fetchedAt, count}`. Each table-seed is `{label, hex, tablePda}` — `label` is the utf-8 view (or `null` when the hint is an already-hashed seed), `hex` is the raw hint bytes, and `tablePda` is the pre-derived Table PDA (the gateway runs the SDK derivation once per refresh so a client just string-compares an incoming pubkey to classify it). |

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
| Chain (Solana / EVM) | Permanent | Source of truth |

The cache layer is chain-agnostic — the same SQLite store, LRU, and dedup serve
both chains. In multi mode every cache key, disk path, and SQLite row carries a
`network` dimension, so one `CACHE_DIR` safely serves all networks in one
process. If you run several locked single-chain instances instead, give each its
own `CACHE_DIR` volume.

Two things in `cache.db` are durable and never LRU-pruned: the FTS5 search
catalog (`catalog_fts`) and the EVM row index (`evm_row_index` +
`evm_index_state`). Both are derived from chain truth and rebuildable, but
keeping them beats re-walking transaction chains.

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

The gateway ships as a chain-agnostic container (see the repo `Dockerfile`). How you run it — bare VPS, docker compose, Kubernetes, Akash, anything — is up to your infra. The gateway only asks for the following contract:

| Requirement | Detail |
|---|---|
| Port | Listens on `PORT` (default `3000`). |
| Env | `IQ_CHAIN` + the matching network/RPC vars (see [Configuration](#configuration)). Inject however your platform does env (`--env-file`, secrets, etc.). |
| Persistent volume | Mount durable storage at `CACHE_DIR` (default `/app/cache`). Use one volume per (chain × network) instance so caches don't collide. Survives restarts; safe to wipe. |
| TLS / routing | Terminate TLS and route your domain to the container at your proxy/ingress layer. The gateway speaks plain HTTP. |

Minimal local run:

```bash
docker build -t iq-gateway .
docker run -d -p 3000:3000 -v iq-cache:/app/cache --env-file .env --restart unless-stopped iq-gateway
```

That's the whole contract — port, env, a persistent `CACHE_DIR`, and a proxy in front. Everything else is your platform's concern, not the gateway's.

## Cache Snapshot

Public read-only snapshot of the gateway's disk cache so a cold peer can bootstrap from a hot one without re-fetching every entry from Solana. The snapshot streams `tar -czf -` directly — first byte arrives quickly even for large caches, and Cloudflare's 100s edge timeout doesn't bite.

### Local bootstrap

```bash
# warm a cold gateway from a peer's hot cache
./scripts/bootstrap-cache-from-peer.sh https://gateway.iqlabs.dev ./cache
# then start (or restart) your gateway
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

The gateway is a read-only cache layer. It never writes to chain. All data is public and recoverable from chain, so multiple gateways serve the same data independently.

The only real divergence between chains lives in `src/chain/`. A `ChainReader`
interface ([src/chain/types.ts](src/chain/types.ts)) is the seam; two adapters
implement it:

```
src/chain/
  types.ts     # ChainReader interface (the shared intersection)
  solana/      # web3.js + Helius + SNS    → implements ChainReader
  evm/         # ethers + Alchemy + ENS    → implements ChainReader
  index.ts     # picks ONE adapter by IQ_CHAIN, re-exports its surface
src/routes/
  *.ts         # Solana route set
  evm/         # EVM route set (per-request wrapper via ctx)
src/cache/     # shared store/LRU/dedup; catalog + durable EVM row index
src/resolver.ts # per-request chain/network resolution (multi mode)
src/server.ts  # boots multi (default) or one locked chain by IQ_CHAIN
```

Importing the inactive adapter is side-effect-free (no top-level RPC or env
throw); EVM defers its provider/network wiring into `initEvm()`, called from
`initChain()` only when `IQ_CHAIN=evm`.

## SNS / sol.site integration

> **Solana only.** On `IQ_CHAIN=evm` these routes are not mounted — EVM uses [ENS](#ens-evm) instead.

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
| `gateway.iqlabs.dev/sns/<name>` | JSON `{domain, owner, record}` — the domain's owner wallet + raw SOL-record value (a wallet/PDA), for dispatcher clients to classify. `?fresh=1` skips the 24h cache. |
| `gateway.iqlabs.dev/sns/<name>/record` | Reads the URL record on-chain, 302s to `/site/<sig>/<file>` (site serving) |
| `<name>.sol` (in Brave with SNS resolution enabled) | Brave reads the URL record, navigates there |
| `<name>.sol.site/<file>` | Requires a CNAME alongside (see below) |

### path-based access

```bash
$ curl -L https://gateway.iqlabs.dev/sns/<your-name>/record
# → 302 → /site/<sig>/<your-index-file> → on-chain content
```

The resolver accepts the domain bare (`/sns/nubs/record`) or with the `.sol` / `.sol.site` suffix.

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
