# IQ Gateway

Serves on-chain stored assets via HTTP for Metaplex NFT/Token compatibility.

## What it does

- Reads data stored on Solana via IQLabs SDK
- Serves Metaplex-compatible JSON metadata at `/meta/{sig}.json`
- Serves raw image bytes at `/img/{sig}.png`
- Caches responses in memory + disk for fast subsequent loads

## Setup

```bash
# Clone
git clone git@github.com:NubsCarson/iq-gateway.git
cd iq-gateway

# Need iqlabs-sdk as sibling directory
git clone git@github.com:IQCoreTeam/iqlabs-solana-sdk.git ../iqlabs-sdk
cd ../iqlabs-sdk && bun install && cd ../iq-gateway

# Install & run
cp .env.example .env
bun install
bun run src/server.ts
```

## Configuration

Edit `.env`:

```
SOLANA_RPC_ENDPOINT=https://api.devnet.solana.com
PORT=3000
BASE_PATH=/iq          # If behind reverse proxy
DEFAULT_CREATOR=       # Your wallet address
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /meta/{sig}.json` | Metaplex-compatible JSON |
| `GET /img/{sig}.png` | Raw image bytes |
| `GET /user/{pubkey}/assets` | List user's assets |

## Minting

```bash
# Token
GATEWAY_URL="https://your-domain.com" bun run scripts/mint-token.ts

# NFT
GATEWAY_URL="https://your-domain.com" bun run scripts/mint-nft.ts
```

## Docker

```bash
docker build -t iq-gateway .
docker run -p 3000:3000 --env-file .env iq-gateway
```

## Architecture

```
Request → Gateway → Memory Cache → Disk Cache → Solana RPC → IQLabs SDK
                           ↓              ↓
                        Response      Cache & Return
```

First request fetches from chain (slow for large files), subsequent requests serve from cache (fast).
