#!/usr/bin/env bash
# Bootstrap a cold gateway's cache by downloading a peer's snapshot.
#
#   ./scripts/bootstrap-cache-from-peer.sh <peer-url> [cache-dir]
#
# Streams the peer's /cache/snapshot into <cache-dir> (default ./cache). Run
# before starting the gateway, or restart it afterwards to pick up the cache.
# How you wire this into your deployment (stop/start, volume mount, etc.) is
# your platform's concern — this script just fetches into a directory.
#
# Example:
#   ./scripts/bootstrap-cache-from-peer.sh https://gateway.iqlabs.dev ./cache

set -euo pipefail

PEER_URL="${1:-}"
CACHE_DIR="${2:-./cache}"
if [ -z "$PEER_URL" ]; then
  echo "usage: $0 <peer-url> [cache-dir]" >&2
  exit 1
fi
PEER_URL="${PEER_URL%/}"

echo "[bootstrap] peer:      $PEER_URL"
echo "[bootstrap] cache-dir: $CACHE_DIR"

INFO=$(curl -sf "$PEER_URL/cache/info") || { echo "[bootstrap] peer /cache/info failed" >&2; exit 2; }
echo "[bootstrap] peer cache: $INFO"

mkdir -p "$CACHE_DIR"
echo "[bootstrap] downloading + extracting snapshot ..."
curl -sSf "$PEER_URL/cache/snapshot" | tar -xz -C "$CACHE_DIR"

[ -f "$CACHE_DIR/cache.db" ] || { echo "[bootstrap] no cache.db in extracted snapshot" >&2; exit 3; }

ENTRIES=$(sqlite3 "$CACHE_DIR/cache.db" "SELECT COUNT(*) FROM cache_entries" 2>/dev/null || echo "?")
SIZE=$(du -sh "$CACHE_DIR" | cut -f1)
echo "[bootstrap] done. entries=$ENTRIES  size=$SIZE"
echo "[bootstrap] start (or restart) the gateway to pick up the new cache."
