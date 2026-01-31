# IQ Gateway - Status

## Last Session: 2026-01-30

### Completed
- [x] SQLite cache tracking with LRU pruning (MAX_CACHE_SIZE env var)
- [x] On-chain gateway registry integration (devnet)
- [x] Peer discovery - gateways query registry for peers
- [x] Routes check peers before hitting Solana RPC
- [x] Auto-register on startup + heartbeat every 2 min

### Uncommitted Changes
```
src/registry/     - NEW: Registry client + peer discovery
idl/              - NEW: Registry program IDL
src/server.ts     - Init registry, heartbeat loop
src/routes/img.ts - Check peers on cache miss
src/routes/meta.ts - Check peers on cache miss
src/routes/health.ts - Show peer info
.env.example      - Updated docs
src/cache/store.ts - NEW: SQLite cache store
src/cache/disk.ts - Uses SQLite store
```

### To Test
- Run with second gateway from different wallet to see peer discovery in action
- Test that peer cache sharing actually works (one gateway caches, other fetches from peer)

### Registry Info (Devnet)
```
Program ID: 4H44PbCzjoJjbg6NyYbueu4s3Q6er1fAL4iNL3atW29w
Registry PDA: 38yR4smksEro6LoC5R9JBNu7j8nUicxHqzdDDWgqJk8f
Your Gateway: https://pi.nubs.site/iq
```

### Commit Messages Ready
```
# For cache changes:
add sqlite cache tracking with configurable storage limit

# For registry/peer changes:
add on-chain gateway registry and peer discovery
```
