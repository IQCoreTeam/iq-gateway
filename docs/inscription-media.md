# Inscription media

`GET /media/:transactionId?network=solana` reconstructs a row through the existing
chain reader and returns its embedded base64 image, audio or video. EVM requests
use the same route with the configured network name and a transaction hash.
The route supports `Range` and returns the original media MIME type.

The row must contain a `body` or `data` string in `data:<mime>;base64,<bytes>` form.
External URLs, HTML, SVG and executable formats are not served. The limit is
8 MiB of encoded content. A bounded in-memory cache avoids reconstructing the
same inscription on every range request. Missing, invalid and unreadable rows
produce explicit errors; this endpoint never fetches a URL found inside a row.

## Local verification

`bun test` includes Solana/EVM route fixtures, byte ranges, cache isolation and
malformed payload checks. `bun run build` checks the production entrypoint.

For an actual signed local inscription, run IQ6900's `tests/local-inscribe.cjs`
against offline Surfpool and save its JSON report. Then run:

```sh
SOLANA_RPC_ENDPOINT=http://127.0.0.1:19109 \
FRESH_RPC_URL=http://127.0.0.1:19109 RECENT_RPC_URL=http://127.0.0.1:19109 \
HELIUS_API_KEY= HELIUS_API_KEYS= \
IQ_MEDIA_REPORT=/absolute/path/local-inscribe-report.json \
  bun tests/local-media.ts
```

The opt-in test uses the actual Solana row reader, verifies reconstructed WAV
bytes and a partial response, and makes no writes. It mounts a local route
harness because production boot deliberately rejects Surfpool's genesis hash.
It does not establish production startup or live RPC reliability.

For signed EVM coverage, start a fresh local fork of Robinhood Chain with Anvil:

```sh
anvil --host 127.0.0.1 --port 18545 --accounts 0 \
  --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663
```

In another terminal, with Alchemy overrides unset:

```sh
IQ_EVM_LOCAL_RPC=http://127.0.0.1:18545 bun tests/local-media.evm.ts
```

This opt-in test refuses non-loopback RPC URLs, requires Anvil and the forked
contract, and generates a disposable signer with synthetic local funds. The fork
reads public chain state; all signed transactions go to Anvil. Official Ethereum
SDK 0.4.0 performs inventory uploads and database writes, then the real gateway
reader and media route verify exact WAV bytes, ranges and executable-content
rejection. Receipts are emitted as JSON. No personal key or mainnet funds are used.
Public RPCs may prune historical state; if an older fork fails with historical-state
errors, restart a fresh test fork or use an archive RPC.

Linked database/connection rows reuse the SDK's `readSendCodeChain`. Previously
`readSingleRow` returned null for those linked rows. Missing chunk-history errors
now propagate as read failures instead of being misreported as absent rows.
Unit tests cover all three supported row functions; the signed fork test covers
inventory and inline/linked database writes.

Deploy and verify this endpoint on the selected gateway before enabling the
BlockChan/HoodChan transaction-reference attachment change. Existing gateways
without the route cannot serve those references. The frontend retains ordinary
media URLs; no browser RPC key or new upload implementation is required.
