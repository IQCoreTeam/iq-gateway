# iq-gateway devnotes

## 2026-09-07 — Robinhood Chain + durable EVM row index

Groundwork for the iq-chan EVM port (Monad + Robinhood Chain).

### Robinhood Chain (chainId 4663)
- Added to `src/chain/evm/networks.ts`: contract
  `0x88af59e58C7E5DcbE7cc12972B90cff3fEEF7223`, default RPC
  `https://rpc.mainnet.chain.robinhood.com`, ETH gas, Blockscout explorer.
  Needs `@iqlabs-official/ethereum-sdk@^0.3.0` (bumped) for the `robinhood`
  setNetwork mode. No testnet contract exists; rehearse on monadTestnet.
- Reachable in multi mode via `?network=robinhood`, or locked via
  `IQ_CHAIN=evm` + `IQETH_NETWORK=robinhood`. Boot validates chainId live.

### Multi-mode dispatch fix
- `extractId()` now treats `/table/dbroot` and `/table/cache/*` as id-less:
  "dbroot"/"cache" are valid base58 but decode to <32 bytes, so they were
  misrouted to the EVM sub-app and iq-chan's `GET /table/dbroot` 400-ed in
  multi mode. They now hit the Solana handler by default; `?network=` still
  overrides to any EVM network.

### Durable EVM row index (the layer-2 database)
EVM has no `getSignaturesForAddress`; the SDK's read path is a strictly
sequential `beforeDataTx` pointer walk, and the two-tx `writeRow` race can
orphan rows off that chain entirely. New durable SQLite tables
(`evm_row_index`, `evm_index_state` in cache.db, never LRU-pruned) index every
row-write tx per (network, dbroot, table):
- fed by live reads / `/notify` / a background `eth_getLogs(DbCodeInEvent)`
  backfill (`src/chain/evm/log-index.ts`) using the contract's indexed topics
  (keccak of dbRootId / tableName). Adaptive chunk spans (halve on RPC range
  errors), resumable via persisted block ranges, background rpc-queue priority.
- once a table is `complete`, deep `before` pagination and `/index` are served
  from SQLite (payloads hydrated lazily via readSingleRow, then persisted);
  head pages stay on the live path so freshness semantics are unchanged.
- rows gained `__blockNumber` (alongside `__txHash`/`__signer`/`__blockTime`)
  so live reads can order the index correctly.
- ops: `GET/POST /admin/evm-index` (state / force a backfill run);
  `/table/cache/stats` reports durable index counters. Env:
  `IQETH_DEPLOY_BLOCK_<NET>`, `IQETH_LOGS_SPAN`.

## 2026-06-01 — Unified Solana + EVM behind one ChainReader (PR #10)

Merged `iq-eth-gateway` into this repo. One codebase, two chains, selected at
boot by `IQ_CHAIN` (`solana` default | `evm`). Implements PR #10's seam.

### What moved
- `src/chain/*.ts` (Solana) → `src/chain/solana/`.
- `iq-eth-gateway/src/chain/*` → `src/chain/evm/` (npm `@iqlabs-official/ethereum-sdk@0.2.2`, not a `file:` link).
- New `src/chain/types.ts` — `ChainReader` interface (the shared intersection only).
- New `src/chain/index.ts` selector — picks shared names from the active adapter,
  re-exports both adapters' chain-specific names (no collisions) so both route
  sets type-check; `server.ts` mounts only the active set.
- EVM routes → `src/routes/evm/`; EVM OpenAPI → `src/openapi.evm.ts`;
  EVM catalog ingest (txHash row shape) → `src/cache/catalog-ingest.evm.ts`.
- `src/utils.ts` gained `isTxHash` / `isEvmAddress` alongside `isValidPublicKey`.
- `src/cache/{disk,store}.ts` CacheType union extended with `"ens"` (superset).

### Key decision — import-safety
Both adapter modules must be import-safe so loading the inactive one (the barrel
imports both to build the selector) can't crash the active chain. The EVM reader
used to **throw at module top-level** if `IQETH_NETWORK` was invalid. That throw
(plus `iqlabs.setNetwork` + provider construction) moved into `initEvm()`, called
from `initChain()` only when `IQ_CHAIN=evm`. `NETWORK`/`NETWORK_CONFIG` fall back
to a default at import; strict validation happens in `initEvm()`. Solana side-
effects are harmless (no env throw, no network call), so its `init` is a no-op.

### Why routes stayed per-chain (not force-merged)
PR #10's premise — "only `src/chain` differs" — is partially wrong in the code:
routes diverge by id format (base58 vs `0x`), row field names (`__txSignature`
vs `__txHash`), validation, and Solana-only site/SNS hosting. Forcing one route
file per endpoint would mean rewriting working, live code. So the merge keeps the
Solana route set byte-identical (zero regression on `gateway.iqlabs.dev`) and
adds the EVM set as a parallel, conditionally-mounted directory.

### Verified
- `bun build --target bun` clean (973 modules, both chain stacks).
- Solana boot: cluster validated, `/sns` mounted, `/ens` 404.
- EVM boot: chainId validated, `/ens` mounted, `/sns` 404; 24/24 endpoint sweep → 200.
- `bun test`: 45/45 (39 Solana + 6 EVM).

## 2025-03-25 — Helius batch decode fix, cache guard, cleanup

### Helius batch decode was silently broken
`readMultipleRows` used `heliusBatchGetTransactions` (single HTTP call) then passed raw JSON
to `reader.readUserInventoryCodeInFromTx()`. The SDK expects proper web3.js objects with
`message.getAccountKeys()` — raw JSON doesn't have class methods. Every batch decode threw
`message.getAccountKeys is not a function`, caught by `Promise.allSettled`, silently returning
0 rows. Production worked only because disk cache was populated via the fallback path
(`readSingleRow` which uses `Connection.getTransaction()` and returns proper objects).

**Fix:** Added `decodeRawTxRow()` — decodes instructions directly from raw JSON via
`BorshInstructionCoder`. Handles inline data posts (on_chain_path empty). Falls back to
`readSingleRow` for session/linked-list posts that need the full SDK read flow.

### Empty response cache guard
Added `if (rows.length > 0)` before `setDiskCache("rows", ...)` in the rows endpoint.
Previously, a failed decode (0 rows) would cache an empty response to disk permanently.

### Code cleanup
- Removed dead `activeRpc` variable (written, never read)
- Removed unused `VersionedTransactionResponse` and `reader` imports
- Removed `parseTransactionToRow` (replaced by `decodeRawTxRow`)
- Inlined `opts` in `fetchRecentSignatures`
- Removed slop comments

### Architecture notes
- `db_code_in` (Zo's new write flow) works fine with SDK 0.1.14 — the IDL has it,
  `CODE_IN_INSTRUCTION_NAMES` includes it, `BorshInstructionCoder` decodes named fields correctly.
- gTFA not used in rows endpoint — per-sig caching (24h, immutable on-chain data) is more
  efficient than re-downloading all full txs every time.
- Helius batch still used for fetching raw txs (1 HTTP vs N), just decoded differently now.

## Deployment

The gateway is a plain container; the deploy target is the operator's choice.
The only build gotcha worth recording:

```bash
# push a classic Docker manifest v2 image (some runtimes reject OCI-only).
# build-and-push.sh pins the buildx flags for this:
#   --provenance=false --sbom=false --output=...,oci-mediatypes=false
./scripts/build-and-push.sh v16 0.2.2 latest
```

Mount `/app/cache` (`CACHE_DIR`) on a persistent volume so it survives image
swaps — see "Redeploy preserves cache" below.

## 2026-05-10 — Cache snapshot (v0.2.x)

Added `GET /cache/info` + `GET /cache/snapshot` for peer bootstrap of cold gateways. Read-only — preserves the gateway's "no writes over HTTP" property. Operators warm a cold instance with `scripts/bootstrap-cache-from-peer.sh`.

### Snapshot internals

`tar.gz` of `CACHE_DIR` with a VACUUM-INTO consistent `cache.db`. Excludes WAL/SHM journal files (recipient sqlite would reject those from a different write epoch).

```ts
const db = new Database(liveDb, { readonly: true });
db.run(`VACUUM INTO '${stageDb}'`);  // bun:sqlite can't bind path as a parameter
```

Falls back to `cp` of the live db if VACUUM fails.

### Redeploy preserves cache

The gateway treats `CACHE_DIR` (`/app/cache`) as durable: a redeploy that only swaps the image should keep the same volume, so the cache survives. Whatever orchestrator runs the container, mount cache on storage whose lifecycle is independent of the container (retain-on-delete) so an accidental container/pod removal doesn't wipe the data.

### 0.2.1 (2026-05-10) — streaming snapshot + path fallback

`GET /cache/snapshot` now streams `tar -czf - .` directly to the response (no buffer-to-file step). Avoids Cloudflare's 100s edge timeout on big caches and keeps memory pressure low.

`getDiskCache` falls back to a canonical `pathFor(type, key)` reconstruction when the stored path doesn't resolve — peer-bootstrapped caches (where the writer's `CACHE_DIR` may differ from ours) still serve hits without manual fixup.

`scripts/bootstrap-cache-from-peer.sh <peer> [cache-dir]` streams a peer's snapshot into a cache directory. Stopping/starting the gateway around it (and any volume wiring) is left to the operator's platform — the script stays deployment-agnostic.

`scripts/build-and-push.sh <tag>...` pins the buildx flags so we never accidentally push an OCI-only image again (Akash's runtime requires the classic Docker manifest v2 format).
