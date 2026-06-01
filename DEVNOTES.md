# iq-gateway devnotes

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

### Akash (gateway)

```bash
# build + push with the buildx flags Akash provider runtimes need
# (--provenance=false --sbom=false --output=...,oci-mediatypes=false)
./scripts/build-and-push.sh v16 0.2.2 latest

# bump akash/deploy.yaml image tag to match, then either paste into
# console.akash.network → Update Deployment, or:
akash tx deployment update akash/deploy.yaml --dseq <DSEQ> --from <KEY>
```

The persistent `/app/cache` disk survives `tx deployment update` as long
as the storage block in the SDL stays byte-identical across versions.

### DNS
`gateway.iqlabs.dev` → Akash ingress

## 2026-05-10 — Cache snapshot (v0.2.x)

Added `GET /cache/info` + `GET /cache/snapshot` for peer bootstrap of cold gateways. Read-only — preserves the gateway's "no writes over HTTP" property. Operators warm a cold instance with `scripts/bootstrap-cache-from-peer.sh`.

### Snapshot internals

`tar.gz` of `CACHE_DIR` with a VACUUM-INTO consistent `cache.db`. Excludes WAL/SHM journal files (recipient sqlite would reject those from a different write epoch).

```ts
const db = new Database(liveDb, { readonly: true });
db.run(`VACUUM INTO '${stageDb}'`);  // bun:sqlite can't bind path as a parameter
```

Falls back to `cp` of the live db if VACUUM fails.

### Akash redeploy preserves cache

The persistent-storage section in `akash/deploy.yaml` stays byte-identical across `tx deployment update` runs. Akash only re-creates the container when the image changes; the `/app/cache` PV survives. Same logic for k8s — the `gateway-cache` PVC has `persistentVolumeReclaimPolicy: Retain`, so even an accidental PVC delete leaves the underlying PV with data intact.

### 0.2.1 (2026-05-10) — streaming snapshot + path fallback

`GET /cache/snapshot` now streams `tar -czf - .` directly to the response (no buffer-to-file step). Avoids Cloudflare's 100s edge timeout on big caches and keeps memory pressure low.

`getDiskCache` falls back to a canonical `pathFor(type, key)` reconstruction when the stored path doesn't resolve — peer-bootstrapped caches (where the writer's `CACHE_DIR` may differ from ours) still serve hits without manual fixup.

`scripts/bootstrap-cache-from-peer.sh --k8s <peer> [ns] [dep]` is the safe restore flow as one command: scale the deployment to 0 → wipe the PVC via a temp pod → untar the peer snapshot → verify the row count → scale back up.

`scripts/build-and-push.sh <tag>...` pins the buildx flags so we never accidentally push an OCI-only image again (Akash's runtime requires the classic Docker manifest v2 format).
