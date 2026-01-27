# IQ Gateway

Serves on-chain stored assets via HTTP for Metaplex NFT/Token compatibility.

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Upload    │     │  IQ Gateway │     │   Metaplex  │
│   Image     │ ──► │  (pi.nubs)  │ ◄── │  Token/NFT  │
│  to Solana  │     │  serves HTTP│     │  uses URI   │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
   Stored as          Fetches from        Wallets like
   chunks on          chain, caches,      Phantom fetch
   Solana             serves as URL       the URI
```

1. **Upload** - Image stored on Solana as transaction chunks
2. **Gateway** - Converts on-chain data to normal HTTP URLs
3. **Mint** - Create token/NFT with URI pointing to gateway
4. **View** - Wallets fetch metadata from gateway, display your image

## Quick Demo

### 1. Setup (one time)
```bash
git clone git@github.com:NubsCarson/iq-gateway.git
cd iq-gateway

# Clone SDK as sibling
git clone git@github.com:IQCoreTeam/iqlabs-solana-sdk.git ../iqlabs-sdk
cd ../iqlabs-sdk && bun install && cd ../iq-gateway

# Install
bun install
cp .env.example .env
```

### 2. Upload an image
```bash
# Upload any image (PNG, JPG, SVG, etc)
bun run scripts/upload-test.ts ~/path/to/your-image.png
```

This returns a **transaction signature** - save it!

### 3. Mint a token with your image
```bash
GATEWAY_URL="https://pi.nubs.site/iq" \
ASSET_SIG="YOUR_TX_SIGNATURE_HERE" \
bun run scripts/mint-token.ts
```

### 4. View your token
- Open the Explorer link from the output
- Add token to Phantom (devnet) - it shows your image!

## Endpoints

| Endpoint | What it does |
|----------|--------------|
| `/health` | Check if gateway is running |
| `/meta/{sig}.json` | Metaplex JSON metadata |
| `/img/{sig}.png` | Raw image bytes |
| `/user/{pubkey}/assets` | List user's uploaded assets |

## Live Gateway

**https://pi.nubs.site/iq/**

Example:
- Metadata: https://pi.nubs.site/iq/meta/52WXtc2TvQbYU3hsTVYLxqSYVCtK6sd3bHUfKZL5LXqR5vfKhCqbSeQpRmzciUpbmgqUxuphvJmX4zWp2a5oJdPp.json
- Image: https://pi.nubs.site/iq/img/52WXtc2TvQbYU3hsTVYLxqSYVCtK6sd3bHUfKZL5LXqR5vfKhCqbSeQpRmzciUpbmgqUxuphvJmX4zWp2a5oJdPp.png

## Configuration

Edit `.env`:
```
SOLANA_RPC_ENDPOINT=https://api.devnet.solana.com
PORT=3000
BASE_PATH=/iq
DEFAULT_CREATOR=
```

## Run Your Own Gateway

```bash
bun run src/server.ts
```

## How Storage Works

Files are stored on Solana using 3 methods based on size:

| Size | Method | Speed |
|------|--------|-------|
| < 900 bytes | Inline (embedded in tx) | Instant |
| 900B - 8.5KB | Linked list of txs | Fast |
| > 8.5KB | Session chunks | Slower first load |

The gateway caches everything after first fetch, so subsequent requests are instant.
