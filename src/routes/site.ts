import { Hono } from "hono";
import { readAsset, decodeAssetData, generateETag } from "../chain/solana";
import { MemoryCache, TTL, getDiskCache, setDiskCache } from "../cache";
import { deduped } from "../cache/dedup";
import { verifiedObjectDiskCache } from "../cache/verified-objects";
import { MAX_CODE_IN_OBJECT_BYTES } from "../chain/solana/code-in-object";
import { busyByteResponse, serveByteSource } from "../http-byte-source";
import { parseRange } from "../http-range";
import { isSolanaSignature } from "../utils";
import { parseChunkedSiteFile, SiteChunkError, SiteChunkStore, type ChunkedSiteFile } from "../site-chunked-file";

export const siteRouter = new Hono();

const manifestCache = new MemoryCache<string>(200);
const manifestReads = new Map<string, Promise<unknown>>();
class SiteManifestBusy extends Error {}
const fileCache = new MemoryCache<Buffer>(500);
const chunkStore = new SiteChunkStore(readAsset, verifiedObjectDiskCache, async (sig) =>
  (await cachedAsset(sig, 2 * MAX_CODE_IN_OBJECT_BYTES))?.data ?? null);

// Sequential read queue to avoid RPC rate limits.
let readQueue: Promise<void> = Promise.resolve();
function enqueueRead<T>(fn: () => Promise<T>): Promise<T> {
  const result = readQueue.then(fn, fn);
  readQueue = result.then(() => {}, () => {});
  return result;
}

// Normalized internal manifest format.
export interface Manifest {
  indexPath: string;
  files: Record<string, string>; // path -> txId
  chunkedFiles?: Record<string, ChunkedSiteFile>;
}

// Gateway format: { index: { path }, paths: { file: { id } } }
// Iqoogle format: { "file": { txId, hash } }
export function parseManifest(raw: Record<string, unknown>): Manifest {
  const files: Record<string, string> = Object.create(null);
  const chunkedFiles: Record<string, ChunkedSiteFile> = Object.create(null);
  function addChunked(path: string, entry: object) {
    if (!("chunked" in entry)) return;
    const descriptor = parseChunkedSiteFile(entry.chunked);
    if (descriptor) chunkedFiles[path] = descriptor;
  }
  let indexPath = "index.html";

  if (raw.paths && typeof raw.paths === "object") {
    const paths = raw.paths as Record<string, { id?: unknown } | undefined>;
    for (const [p, entry] of Object.entries(paths)) {
      if (typeof entry?.id === "string" && entry.id) files[p] = entry.id;
      else if (entry && typeof entry === "object") addChunked(p, entry);
    }
    if (raw.index && typeof raw.index === "object") {
      const path = (raw.index as { path?: unknown }).path;
      if (typeof path === "string" && path) indexPath = path;
    }
  } else {
    for (const [p, entry] of Object.entries(raw)) {
      if (entry && typeof entry === "object") {
        const id = (entry as { txId?: unknown }).txId;
        if (typeof id === "string" && id) files[p] = id;
        else addChunked(p, entry);
      }
    }
  }

  return { indexPath, files,
    ...(Object.keys(chunkedFiles).length ? { chunkedFiles } : {}),
  };
}

function hasFiles(manifest: Manifest) {
  return Object.keys(manifest.files).length > 0 || Boolean(manifest.chunkedFiles);
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html;charset=UTF-8",
  htm: "text/html;charset=UTF-8",
  css: "text/css;charset=UTF-8",
  js: "application/javascript;charset=UTF-8",
  mjs: "application/javascript;charset=UTF-8",
  json: "application/json;charset=UTF-8",
  txt: "text/plain;charset=UTF-8",
  xml: "application/xml;charset=UTF-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

function getMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

async function fetchManifest(sig: string): Promise<Manifest> {
  const key = `manifest:${sig}`;
  const cached = manifestCache.get(key);
  if (cached) return JSON.parse(cached) as Manifest;
  if (manifestReads.size >= 16 && !manifestReads.has(key)) throw new SiteManifestBusy();
  return deduped(manifestReads, key, () => readManifest(sig, key));
}

async function cachedAsset(sig: string, maxBytes?: number): Promise<{ data: string; metadata?: string } | null> {
  const stored = await getDiskCache("meta", `data:${sig}`, undefined, maxBytes);
  if (!stored) return null;
  try {
    const { data, metadata } = JSON.parse(stored.toString("utf8"));
    return typeof data === "string" && data
      ? { data, metadata: typeof metadata === "string" ? metadata : undefined } : null;
  } catch {
    return null;
  }
}

async function readManifest(sig: string, key: string): Promise<Manifest> {
  const disk = await getDiskCache("site", sig);
  if (disk) {
    const text = new TextDecoder().decode(disk);
    manifestCache.set(key, text, TTL.META_IMMUTABLE);
    return JSON.parse(text) as Manifest;
  }

  const backfill = await cachedAsset(sig);
  if (backfill) {
    try {
      const decoded = decodeAssetData(backfill.data);
      const manifest = parseManifest(JSON.parse(decoded.toString("utf-8")));
      if (hasFiles(manifest)) {
        const normalized = JSON.stringify(manifest);
        manifestCache.set(key, normalized, TTL.META_IMMUTABLE);
        await setDiskCache("site", sig, Buffer.from(normalized));
        return manifest;
      }
    } catch {}
  }

  const { data } = await readAsset(sig);
  if (!data) throw new Error("manifest not found");
  const decoded = decodeAssetData(data);
  const text = decoded.toString("utf-8");
  const raw = JSON.parse(text);
  const manifest = parseManifest(raw);

  if (!hasFiles(manifest)) {
    throw new Error("invalid manifest: no files found");
  }

  const normalized = JSON.stringify(manifest);
  manifestCache.set(key, normalized, TTL.META_IMMUTABLE);
  await setDiskCache("site", sig, Buffer.from(normalized));
  return manifest;
}

async function fetchFile(sig: string): Promise<Buffer> {
  if (!isSolanaSignature(sig)) throw new Error("invalid site asset signature");
  const key = `file:v2:${sig}`;
  const diskKey = `v2:${sig}`;
  const cached = fileCache.get(key);
  if (cached) return cached;

  const disk = await getDiskCache("site-file", diskKey);
  if (disk) {
    fileCache.set(key, disk, TTL.IMAGE);
    return disk;
  }

  const backfill = await cachedAsset(sig);
  if (backfill) {
    try {
      const buf = decodeAssetData(backfill.data, backfill.metadata);
      fileCache.set(key, buf, TTL.IMAGE);
      await setDiskCache("site-file", diskKey, buf);
      return buf;
    } catch {}
  }

  return enqueueRead(async () => {
    const rechecked = fileCache.get(key);
    if (rechecked) return rechecked;

    const { data, metadata } = await readAsset(sig);
    if (!data) throw new Error("file not found");

    const buf = decodeAssetData(data, metadata);
    fileCache.set(key, buf, TTL.IMAGE);
    await setDiskCache("site-file", diskKey, buf);
    return buf;
  });
}

export function buildFileResponse(
  buf: Buffer,
  filePath: string,
  range?: string | null,
): Response {
  const mime = getMimeType(filePath);
  const isImmutable = !filePath.endsWith(".html") && !filePath.endsWith(".htm");
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": isImmutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    // Advertise range support so iOS Safari will stream <video>/<audio> sources.
    // Without this, mobile Safari refuses to play media served as a plain 200.
    "Accept-Ranges": "bytes",
    ETag: generateETag(buf),
  };

  const parsed = parseRange(range, buf.length);
  if (parsed) {
    const { start, end } = parsed;
    const slice = buf.subarray(start, end + 1);
    headers["Content-Range"] = `bytes ${start}-${end}/${buf.length}`;
    return new Response(new Uint8Array(slice), { status: 206, headers });
  }

  return new Response(new Uint8Array(buf), { status: 200, headers });
}

export function resolveFile(manifest: Manifest, filePath: string): string | null {
  let p = filePath;
  if (!p || p === "/") p = manifest.indexPath;
  if (p.startsWith("/")) p = p.slice(1);
  return Object.hasOwn(manifest.files, p) && typeof manifest.files[p] === "string" ? manifest.files[p] : null;
}

// Request-scoped helper. No globals. Each call serves files from the manifest
// passed in — never from any prior request's manifest.
export async function serveManifestPath(input: {
  manifestSig: string;
  filePath: string;
  indexPath?: string;
  spaFallback?: boolean;
  ifNoneMatch?: string | null;
  range?: string | null;
  signal?: AbortSignal;
  method?: string;
}): Promise<Response> {
  const { manifestSig, filePath, indexPath, spaFallback, ifNoneMatch, range } = input;
  if (!isSolanaSignature(manifestSig)) return new Response("invalid manifest signature", { status: 400 });

  let manifest: Manifest;
  try {
    manifest = await fetchManifest(manifestSig);
  } catch (e) {
    if (e instanceof SiteManifestBusy) return busyByteResponse();
    return new Response(
      `manifest error: ${e instanceof Error ? e.message : "unknown"}`,
      { status: 404, headers: { "Content-Type": "text/plain" } },
    );
  }

  const effectiveIndex = indexPath ?? manifest.indexPath;
  const lookupManifest: Manifest =
    indexPath && indexPath !== manifest.indexPath
      ? { ...manifest, indexPath: effectiveIndex }
      : manifest;

  const requestedPath = !filePath || filePath === "/" ? effectiveIndex : filePath.replace(/^\//, "");
  const getChunked = (path: string) => {
    const files = manifest.chunkedFiles;
    return files && Object.hasOwn(files, path) ? files[path] : undefined;
  };
  let targetTxId = resolveFile(lookupManifest, filePath);
  let servePath = requestedPath;
  let chunked = getChunked(servePath);
  if (!targetTxId && !chunked && spaFallback) {
    servePath = effectiveIndex;
    targetTxId = resolveFile(lookupManifest, effectiveIndex);
    chunked = getChunked(servePath);
  }
  if (chunked) {
    try {
      const response = await serveByteSource(chunkStore.source(chunked), {
        range, signal: input.signal, method: input.method, contentType: "application/octet-stream",
      });
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Access-Control-Expose-Headers", "Content-Range, Retry-After");
      return response;
    } catch (error) {
      const status = error instanceof SiteChunkError ? error.status : 502;
      if (status === 503) return busyByteResponse();
      return new Response("Could not read the verified site file", { status });
    }
  }

  if (!targetTxId) {
    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  let buf: Buffer;
  try {
    buf = await fetchFile(targetTxId);
  } catch (e) {
    return new Response(
      `file error: ${e instanceof Error ? e.message : "unknown"}`,
      { status: 500, headers: { "Content-Type": "text/plain" } },
    );
  }

  const res = buildFileResponse(buf, servePath, range);
  // A range request wants bytes, not a 304 — only short-circuit to Not Modified
  // for full requests.
  if (res.status !== 206) {
    const etag = res.headers.get("ETag");
    if (etag && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
  }
  return res;
}

// GET /site/:manifestSig/manifest -> returns normalized manifest as JSON
// Registered before the catch-all `:sig{.+}` so it isn't swallowed by it.
// Lets clients (e.g. iq-wide-web) read the file list + indexPath without
// having to parse the two raw manifest formats themselves.
siteRouter.get("/:sig/manifest", async (c) => {
  const sig = c.req.param("sig");
  if (!isSolanaSignature(sig)) return c.text("invalid manifest signature", 400);
  try {
    const manifest = await fetchManifest(sig);
    return c.json({ manifestSig: sig, ...manifest });
  } catch (e) {
    if (e instanceof SiteManifestBusy) return busyByteResponse();
    return c.text(
      `manifest error: ${e instanceof Error ? e.message : "unknown"}`,
      404,
    );
  }
});

// GET /site/:manifestSig          -> redirects to the directory URL
// GET /site/:manifestSig/*path    -> serves file at path
// SPA fallback on miss matches the legacy behavior.
siteRouter.get("/:sig{.+}", async (c) => {
  const raw = c.req.param("sig");
  const slashIdx = raw.indexOf("/");
  const manifestSig = slashIdx > 0 ? raw.slice(0, slashIdx) : raw;
  const filePath = slashIdx > 0 ? raw.slice(slashIdx + 1) : "";

  if (!isSolanaSignature(manifestSig)) {
    return c.text("invalid manifest signature", 400);
  }
  const { pathname, search } = new URL(c.req.url);
  if (!filePath && !pathname.endsWith("/")) return c.redirect(`/site/${manifestSig}/${search}`, 308);

  const response = await serveManifestPath({
    manifestSig,
    filePath,
    spaFallback: true,
    ifNoneMatch: c.req.header("If-None-Match") ?? null,
    range: c.req.header("Range") ?? null,
    signal: c.req.raw.signal,
    method: c.req.method,
  });

  return response;
});
