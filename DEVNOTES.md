# iq-gateway devnotes

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
docker build -t iq-gateway:1.2 .
docker tag iq-gateway:1.2 <registry>/iq-gateway:1.2
docker push <registry>/iq-gateway:1.2
# Update SDL image tag, then:
akash tx deployment update deploy.yml --from wallet
```

### DNS
`gateway.solanainternet.com` → Akash ingress
