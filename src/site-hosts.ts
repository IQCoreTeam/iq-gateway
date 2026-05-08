// Helpers for the host-routed manifest middleware. Path safety + host

// Reserved gateway path prefixes that must always pass through to existing
// routers, even when the Host has a configured pinned site. Matches the
// /<prefix> and /<prefix>/* shapes.
export const RESERVED_GATEWAY_PATHS = [
  "/site",
  "/data",
  "/img",
  "/meta",
  "/render",
  "/view",
  "/table",
  "/user",
  "/gate",
  "/openapi.json",
  "/docs",
  "/health",
  "/version",
  "/sns",
] as const;

export function isReservedGatewayPath(path: string): boolean {
  for (const r of RESERVED_GATEWAY_PATHS) {
    if (path === r || path.startsWith(r + "/")) return true;
  }
  return false;
}

// Lower-case + strip optional :port. Returns null for missing/blank input
// so callers can short-circuit.
export function normalizeHost(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

// Path safety: reject traversal (..), backslashes, and absolute / scheme-
// relative URLs. Empty string and "/" are accepted as "serve index".
export function isSafePath(path: string): boolean {
  if (path === "" || path === "/") return true;
  if (path.includes("..")) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+\-.]*:/i.test(path)) return false;
  return true;
}
