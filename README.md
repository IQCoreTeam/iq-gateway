# IQ Gateway

Serves on-chain stored assets via HTTP for Metaplex NFT/Token compatibility.

## Why This Exists

**Problem:** Metaplex tokens/NFTs need a URL for metadata and images. Traditional solutions use centralized storage (AWS, IPFS pinning services) that can go down or cost money.

**Solution:** Store data directly on Solana, serve it via a gateway that converts on-chain data to HTTP URLs.

**Benefits:**
- **Permanent** - Data lives on Solana forever, no hosting fees
- **Decentralized** - Anyone can run a gateway, data is always recoverable
- **Lazy loading** - Gateway fetches on-demand, no pre-registration needed
- **Cached** - First request fetches from chain, subsequent requests are instant

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  1. Upload  │     │ 2. Gateway  │     │  3. Mint    │
│   Image to  │     │   serves    │     │  Token with │
│   Solana    │     │   HTTP URLs │     │  gateway URL│
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
   Get TX sig          Any TX sig         Wallets fetch
   (your asset ID)     works - even       from gateway
                       uncached ones!     and see image
```

### The Magic: Lazy Caching

**You can mint a token with ANY valid tx signature - even one the gateway has never seen.**

When someone (wallet, explorer, etc.) fetches the metadata URL:
1. Gateway checks memory cache → miss
2. Gateway checks disk cache → miss
3. Gateway fetches from Solana blockchain
4. Gateway reconstructs the data from chain
5. Gateway caches it forever
6. Returns the data

**This means:**
- Upload image → get tx sig → mint token immediately
- No need to "register" with the gateway first
- Gateway discovers and caches assets on-demand
- Multiple gateways can serve the same on-chain data

### Storage Methods

Files are stored on Solana using 3 methods based on size:

| Size | Method | First Load | How It Works |
|------|--------|------------|--------------|
| < 900 bytes | Inline | ~100ms | Data embedded directly in transaction |
| 900B - 8.5KB | Linked List | ~1-5s | Chain of transactions linked together |
| > 8.5KB | Session Chunks | ~30-90s | Multiple chunk transactions in a session |

After first load, everything is cached and serves instantly (~5ms).

## Quick Demo

### 1. Setup
```bash
# Clone this repo and the SDK
# Install SDK
cd iqlabs-sdk && bun install && cd ..

# Install gateway
cd iq-gateway && bun install
cp .env.example .env
```

Need devnet SOL:
```bash
solana airdrop 2 --url devnet
```

### 2. Upload an image
```bash
bun run scripts/upload-test.ts ~/path/to/image.png
```
Save the **TX signature** it outputs!

### 3. Mint a token
```bash
GATEWAY_URL="http://localhost:3000" \
ASSET_SIG="YOUR_TX_SIG" \
bun run scripts/mint-token.ts
```

### 4. View it
- Click the Explorer link
- Add token to Phantom (devnet mode)
- See your on-chain image!

## Live Gateway

**http://localhost:3000/**

Try it:
```bash
# Health check
curl http://localhost:3000/health

# Get metadata (even for a tx sig the gateway has never seen!)
curl http://localhost:3000/meta/YOUR_TX_SIG.json

# Get image
curl http://localhost:3000/img/YOUR_TX_SIG.png
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check + cache stats |
| `GET /meta/{sig}.json` | Metaplex-compatible JSON metadata |
| `GET /img/{sig}.png` | Raw image/file bytes |
| `GET /user/{pubkey}/assets` | List assets uploaded by a wallet |

## Run Your Own Gateway

```bash
# Edit .env
SOLANA_RPC_ENDPOINT=https://api.devnet.solana.com
PORT=3000
BASE_PATH=          # Set if behind reverse proxy (e.g., /iq)

# Run
bun run src/server.ts
```

## Why Decentralized Gateways Matter

1. **No single point of failure** - If one gateway goes down, spin up another
2. **Data is always recoverable** - It's on Solana, any gateway can serve it
3. **No vendor lock-in** - Switch gateways anytime, same data
4. **Community operated** - Anyone can run a gateway for the network

The gateway is just a **cache layer** - the real data lives on Solana forever.
