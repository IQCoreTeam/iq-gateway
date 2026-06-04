# How the SNS integration works

> **Scope:** this doc covers the Solana name-service integration, active only when
> `IQ_CHAIN=solana`. On `IQ_CHAIN=evm` the gateway uses **ENS** instead — forward
> resolve at `GET /ens/{name}`, reverse at `GET /ens/{addr}/reverse` (dedicated
> mainnet RPC via `ENS_RPC_ENDPOINT`, cached 30 min). There is no `*.sol.site`
> host-routing or `/site/*` manifest hosting on EVM in v1.

The IQ Gateway resolves Solana Name Service (SNS) domains to on-chain IQ manifests at request time. One URL record on a `.sol` domain powers three browser surfaces:

- `<your-name>.sol` (in Brave with native SNS resolution enabled)
- `<your-name>.sol.site/<file>` (in any browser, via sol.site's HTTPS infrastructure)
- `gateway.iqlabs.dev/sns/<your-name>` (in any browser, no DNS step)

The on-chain content (an IQ manifest) is the same across all three. The gateway code is open source and any operator can run their own gateway.

## For users — set one record

On your `.sol` domain via [sns.id](https://www.sns.id), connect your owner wallet and set:

| Field | Value |
|---|---|
| Record type | **URL** |
| Value | `https://gateway.iqlabs.dev/site/<your-sig>/<your-index-file>` |

Sign the transaction (~30 seconds, ~0.0001 SOL).

### Include the file path

Many manifests have a non-standard `indexPath` (e.g. `gameboy.html`, not `index.html`). The gateway extracts both the sig AND the file path from the URL value, so the path you bake in becomes the default file when someone hits `<your-name>.sol` or `<your-name>.sol.site` (no path).

```
✓ https://gateway.iqlabs.dev/site/<sig>/gameboy.html       (works for all surfaces)
✗ https://gateway.iqlabs.dev/site/<sig>/                   (only works if your manifest's index resolves to a real file)
```

### Optional: enable the `<name>.sol.site` URL

The URL record alone covers `<name>.sol` (Brave native) and `gateway.iqlabs.dev/sns/<name>` (any browser). For the prettier `<name>.sol.site` URL, also set a CNAME via the **"Configure Sol.site"** UI on sns.id:

| Field | Value |
|---|---|
| Record type | **CNAME** |
| Value | `sns.iqlabs.dev` |

`sns.iqlabs.dev` is a direct A record to the gateway origin (no CDN proxy in front). Sol.site materialises the CNAME as DNS, traffic reaches the gateway, the host middleware reads the URL record on-chain, and the manifest serves.

If the gateway's IP ever changes, the A record on `sns.iqlabs.dev` is updated once. Every CNAME-pointing user keeps working without their own changes.

### Quick test

```bash
# 1. path-based (works first, no DNS dependency)
curl -L https://gateway.iqlabs.dev/sns/<your-name>

# 2. .sol.site (works after the optional CNAME, ~5 min DNS propagation)
curl -L https://<your-name>.sol.site/

# 3. native .sol — open in Brave with SNS resolution enabled:
#    Settings → Privacy → Web3 → Solana Name Service → Enabled
```

## For engineers — how the resolver works

### Request flow (path-based)

```
GET /sns/nubs/gameboy.html
  ↓ src/routes/sns.ts
strip .sol / .sol.site suffix → "nubs"
  ↓ src/chain/sns.ts → resolveDomainToSig("nubs")
memory cache hit? → return sig
  ↓ miss
disk cache hit? → return sig
  ↓ miss
@bonfida/spl-name-service.getMultipleRecordsV2(conn, "nubs", [Url, TXT])
  ↓
extract content from raw account data (V2 layout: [header][last contentLength bytes])
  ↓
regex match: bare 86-90 char base58 sig, OR URL containing /site/<sig>/[file]
  ↓ found
cache positive (5 min, memory + disk)
  ↓
return "<sig>" or "<sig>/<path>" to route handler
  ↓
302 redirect to /site/<sig>/<file>
  ↓
existing /site router serves manifest content from on-chain
```

### Request flow (host-based)

```
GET https://nubs.sol.site/gameboy.html
  ↓
DNS: nubs.sol.site → CNAME materialised by sol.site → A → gateway origin
  ↓
Traefik: HostRegexp(`^[a-z0-9-]+\.sol\.site$`) → gateway service
  ↓
src/server.ts host middleware
  - skip reserved gateway paths (/site, /data, /health, /sns, …)
  - strip ".sol.site" from Host → "nubs"
  - call resolveDomainToSig("nubs") — same function as path-based
  - if request path is "/", use any path baked into the URL record as the index
  - call serveManifestPath({manifestSig, filePath, …})
  ↓
src/routes/site.ts:serveManifestPath
  (same as path-based, but no redirect — direct response)
```

### Why URL record (not TXT)?

Per [docs.sns.id/dev/web-resolution](https://docs.sns.id/dev/web-resolution), the SNS web-resolution spec checks records in this priority:

1. **URL** ← what Brave native and sol-domain.org check first
2. IPFS
3. ARWV
4. SHDW

Setting `Record.URL` to a URL containing `/site/<sig>/<file>` makes ALL these surfaces work simultaneously:
- Brave native `<name>.sol` → navigates to the URL value
- sol-domain.org → same
- our `gateway.iqlabs.dev/sns/<name>` → reads URL, extracts sig, redirects
- our `<name>.sol.site` host middleware → reads URL, extracts sig, serves manifest

`Record.TXT` is accepted as a fallback for users who reserve URL for something else.

### Why we read raw account data instead of the SDK's `deserializedContent`

`@bonfida/spl-name-service@3.0.21` exposes `getRecordV2(conn, domain, type)`:

```ts
{
  retrievedRecord: { data: Buffer, header: { contentLength, ... } },
  deserializedContent: string | undefined,  // BROKEN for URL records
  verified: { staleness: bool, roa: bool }
}
```

`deserializedContent` is `undefined` for URL records. When we tried `deserializeRecordV2Content()` directly, it returned a string truncated mid-content (stopping somewhere inside the 88-character sig). So the SDK has a bug for URL deserialisation.

The V2 record account layout is well-defined: a fixed-size header followed by `header.contentLength` bytes of content. We slice the last `contentLength` bytes from `retrievedRecord.data` and decode as UTF-8. Reliable, unambiguous.

### Caching

| Layer | Size | TTL | Purpose |
|---|---|---|---|
| Memory (LRU) | 500 entries | 5 min | Hot domains |
| Disk (SQLite-backed) | bounded by `MAX_CACHE_SIZE` (10 GB) | 5 min | Survives restarts |
| In-flight dedup | unbounded Map | request lifetime | Thundering-herd protection (concurrent cold-cache requests for the same domain → one Solana RPC call) |

Both positive AND negative results are cached. Negative cache uses sentinel `__none__` to protect Solana RPC from junk lookups.

### Multi-gateway protocol

The IQ Gateway is open source and the URL record format is operator-agnostic. Different SNS holders can point their `Record.URL` at different IQ gateway operators:

```
URL = https://gateway.iqlabs.dev/site/<sig>/             # iqlabs gateway
URL = https://your-own-gateway.com/site/<sig>/           # someone else's
```

When ANY iq-gateway resolves a `.sol`, the regex extracts the sig from whichever gateway URL was set. The user picks the operator they trust; the on-chain content is the same. Multiple gateways = no single point of failure.

This pattern is already production: at least one other operator runs the same `iq-gateway` code (their homepage explicitly says "Run your own: iq-gateway").

## TLS for `*.sol.site`

Traefik issues per-host Let's Encrypt certificates via TLS-ALPN-01 on first hit. Cold path is ~5–10 seconds for cert issuance; subsequent requests reuse the cached cert (`/data/acme.json`). LE rate limit is 50 certs / week per registered domain (`sol.site`) — sufficient for organic adoption.

## Code surface

| File | Role |
|---|---|
| `src/chain/sns.ts` | `resolveDomainToSig(domain)` — module-level Connection, two-tier cache, dedup |
| `src/routes/sns.ts` | `GET /sns/:domain[/*]` → 302 redirect |
| `src/server.ts` | `*.sol.site` host middleware (`sns-host-based` branch) |
| `src/site-hosts.ts` | `isReservedGatewayPath`, `normalizeHost`, `isSafePath` |
| `src/routes/health.ts` | Exposes `sns` cache size + `snsInflight` count at `/health` |
| `tests/sns-resolver.test.ts` | Unit tests for the regex + V2 contentLength slicing |
| `tests/site-hosts.test.ts` | Unit tests for the path-safety helpers |
| `tests/site-parser.test.ts` | Existing manifest parser tests |

## Branches

- `sns` — path-based `/sns/<domain>` resolver. Live in production.
- `sns-host-based` — `*.sol.site` host middleware on top of `sns`. Currently deployed.

`sns-host-based` is a strict superset of `sns`. Adds the `*.sol.site` host middleware in `src/server.ts`. Full functionality also needs a wildcard route for `*.sol.site` at your ingress/proxy layer (operator-specific). Deploy this branch for full functionality; deploy `sns` only if you want path-based access without host routing.
