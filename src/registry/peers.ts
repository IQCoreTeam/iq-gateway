import { RegistryClient } from "./client";

const PEER_CACHE_TTL = 60_000; // 1 minute
const PEER_TIMEOUT = 5_000; // 5 seconds

let registryClient: RegistryClient | null = null;
let cachedPeers: string[] = [];
let lastFetch = 0;

export function initRegistry(rpcUrl: string, selfUrl: string, keypairPath?: string) {
  registryClient = new RegistryClient(rpcUrl, selfUrl, keypairPath);
}

export async function registerSelf(): Promise<void> {
  if (!registryClient) return;
  await registryClient.register();
}

export async function sendHeartbeat(): Promise<void> {
  if (!registryClient) return;
  await registryClient.heartbeat();
}

export async function getPeers(): Promise<string[]> {
  if (!registryClient) return [];

  const now = Date.now();
  if (now - lastFetch < PEER_CACHE_TTL && cachedPeers.length > 0) {
    return cachedPeers;
  }

  cachedPeers = await registryClient.fetchPeers();
  lastFetch = now;
  return cachedPeers;
}

export async function fetchFromPeers(
  path: string
): Promise<{ data: Buffer; contentType: string } | null> {
  const peers = await getPeers();
  if (peers.length === 0) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PEER_TIMEOUT);

  try {
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const url = `${peer}${path}`;
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { "X-Peer-Request": "true" },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return {
          data: Buffer.from(await res.arrayBuffer()),
          contentType: res.headers.get("content-type") || "application/octet-stream",
        };
      })
    );

    clearTimeout(timeout);

    for (const result of results) {
      if (result.status === "fulfilled") {
        return result.value;
      }
    }

    return null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}
