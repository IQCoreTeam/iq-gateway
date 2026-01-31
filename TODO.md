# IQ Gateway - TODO

## Last Updated: 2026-01-31

---

## Current Status

### Completed
- [x] SQLite cache tracking with LRU pruning (MAX_CACHE_SIZE env var)
- [x] On-chain gateway registry integration (devnet)
- [x] Peer discovery - gateways query registry for peers
- [x] Routes check peers before hitting Solana RPC
- [x] Auto-register on startup + heartbeat every 2 min
- [x] Pushed to `registry` branch

### Registry Info (Devnet)
```
Program ID: 4H44PbCzjoJjbg6NyYbueu4s3Q6er1fAL4iNL3atW29w
Registry PDA: 38yR4smksEro6LoC5R9JBNu7j8nUicxHqzdDDWgqJk8f
Your Gateway: https://pi.nubs.site/iq
```

---

## Phase 1: Version Verification Endpoint

### 1.1 Add /version Endpoint
```typescript
GET /version
{
  "version": "1.0.0",
  "docker_hash": "sha256:abc123...",
  "version_tx": "codein_tx_signature",
  "source_hash": "sha256:def456...",
  "uptime": 3600,
  "timestamp": 1706745600,
  "pubkey": "gateway_pubkey",
  "signature": "signed_by_gateway_key"
}
```

- [ ] Create `/version` route
- [ ] Read version from package.json or env
- [ ] Read docker_hash from DOCKER_HASH env var
- [ ] Read version_tx from VERSION_TX env var
- [ ] Sign response with gateway keypair
- [ ] Return all info as JSON

### 1.2 Environment Variables
```bash
VERSION=1.0.0
DOCKER_HASH=sha256:abc123...
VERSION_TX=5abc123...  # CodeIn tx signature
```

- [ ] Add to .env.example
- [ ] Document in README

---

## Phase 2: Docker Setup

### 2.1 Dockerfile
```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]
```

- [ ] Create Dockerfile
- [ ] Create .dockerignore
- [ ] Test local build
- [ ] Verify deterministic builds

### 2.2 GitHub Actions CI/CD
```yaml
# .github/workflows/docker.yml
- Build on push to main
- Push to ghcr.io/iqcoreteam/iq-gateway
- Tag with version and sha256 hash
- Output hash for on-chain storage
```

- [ ] Create workflow file
- [ ] Set up GHCR permissions
- [ ] Test pipeline
- [ ] Document hash extraction

### 2.3 Docker Compose (for operators)
```yaml
version: '3.8'
services:
  iq-gateway:
    image: ghcr.io/iqcoreteam/iq-gateway:v1.0.0
    ports:
      - "3000:3000"
    environment:
      - SOLANA_RPC_ENDPOINT=https://...
      - GATEWAY_URL=https://mygateway.com
    volumes:
      - ./keys:/keys
      - ./cache:/app/cache
```

- [ ] Create docker-compose.yml
- [ ] Document volume mounts
- [ ] Add to README

---

## Phase 3: Staking Integration

### 3.1 Update Registration Flow
Once registry contract supports IQ staking:

- [ ] Update RegistryClient to handle IQ token transfer
- [ ] Check wallet has enough IQ before registering
- [ ] Display required stake amount (escalating curve)
- [ ] Handle stake token account creation

### 3.2 Display Stake Info
```typescript
GET /health
{
  ...
  "stake": {
    "amount": 100000,
    "token": "IQ",
    "gateway_number": 5,
    "next_stake_required": 600000
  }
}
```

- [ ] Add stake info to /health endpoint
- [ ] Query on-chain for current stake
- [ ] Show gateway number in network

---

## Phase 4: Metrics & Monitoring

### 4.1 Request Metrics
```typescript
{
  "requests_served": 12345,
  "cache_hits": 10000,
  "cache_misses": 2345,
  "peer_fetches": 500,
  "chain_fetches": 1845,
  "bytes_served": 1234567890,
}
```

- [ ] Track request counts
- [ ] Track cache hit/miss ratio
- [ ] Track bytes served
- [ ] Expose in /health or /metrics

### 4.2 Prometheus Metrics (Optional)
- [ ] Add prom-client or similar
- [ ] Expose /metrics endpoint
- [ ] Standard metrics format
- [ ] Grafana dashboard template

---

## Phase 5: Rewards Claiming

Once registry contract supports rewards:

- [ ] Check pending rewards
- [ ] Add claim_rewards to CLI
- [ ] Show rewards in /health
- [ ] Auto-claim option (optional)

---

## Quick Tasks

- [ ] Merge registry branch to main
- [ ] Update README with registry info
- [ ] Add operator documentation
- [ ] Create troubleshooting guide

---

## File Structure After Changes
```
iq-gateway/
├── src/
│   ├── server.ts
│   ├── routes/
│   │   ├── health.ts
│   │   ├── img.ts
│   │   ├── meta.ts
│   │   ├── user.ts
│   │   └── version.ts      # NEW
│   ├── registry/
│   │   ├── client.ts
│   │   ├── peers.ts
│   │   └── index.ts
│   ├── cache/
│   │   ├── memory.ts
│   │   ├── disk.ts
│   │   └── store.ts
│   └── chain/
│       └── reader.ts
├── Dockerfile              # NEW
├── docker-compose.yml      # NEW
├── .dockerignore           # NEW
├── .github/
│   └── workflows/
│       └── docker.yml      # NEW
└── ...
```

---

## Related
- See `iq-gateway-registry/TODO.md` for contract-side tasks
- IQ Token: 3uXMvWmp2REmEbNNM1F41eZoxMFjvv2q8s9i2Q7JfDpL

---

<!--
## MAYBE FUTURE: Content Filtering (NOT protocol level - operator/client choice)

This should NOT be enforced at protocol level. No censorship.
Individual gateway operators or client apps can choose to implement filtering.

### Operator-Optional File Type Filtering
```typescript
// Gateway operator can enable via env var: ENABLE_FILETYPE_FILTER=true
const ALLOWED_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/json', 'application/pdf', 'text/plain',
];
```

### Client-Side Filtering
- Client apps (browsers, wallets) can choose what to display
- Users control their own filtering preferences
- No protocol-level blocking

### Operator Blocklist (Optional)
- Individual operators can maintain their own blocklist
- Not shared or enforced network-wide
- Operators responsible for their own legal compliance

Philosophy: Gateways serve everything. Filtering is user/operator choice, not protocol enforcement.
-->
