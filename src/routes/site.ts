import { Hono } from "hono";
import { readAsset, decodeAssetData, generateETag } from "../chain";
import { MemoryCache, TTL, getDiskCache, setDiskCache } from "../cache";

export const siteRouter = new Hono();

const manifestCache = new MemoryCache<string>(200);
const fileCache = new MemoryCache<Buffer>(500);

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
}

// Gateway format: { index: { path }, paths: { file: { id } } }
// Iqoogle format: { "file": { txId, hash } }
export function parseManifest(raw: Record<string, unknown>): Manifest {
  const files: Record<string, string> = {};
  let indexPath = "index.html";

  if (raw.paths && typeof raw.paths === "object") {
    const paths = raw.paths as Record<string, { id: string }>;
    for (const [p, entry] of Object.entries(paths)) {
      if (entry?.id) files[p] = entry.id;
    }
    if (raw.index && typeof raw.index === "object" && (raw.index as { path?: string }).path) {
      indexPath = (raw.index as { path: string }).path;
    }
  } else {
    for (const [p, entry] of Object.entries(raw)) {
      if (entry && typeof entry === "object" && (entry as { txId?: string }).txId) {
        files[p] = (entry as { txId: string }).txId;
      }
    }
  }

  return { indexPath, files };
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

  const disk = await getDiskCache("site", sig);
  if (disk) {
    const text = new TextDecoder().decode(disk);
    manifestCache.set(key, text, TTL.META_IMMUTABLE);
    return JSON.parse(text) as Manifest;
  }

  const backfillData = await getDiskCache("meta", `data:${sig}`);
  if (backfillData) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(backfillData));
      if (parsed.data) {
        const decoded = decodeAssetData(parsed.data);
        const text = decoded.toString("utf-8");
        const raw = JSON.parse(text);
        const manifest = parseManifest(raw);
        if (Object.keys(manifest.files).length > 0) {
          const normalized = JSON.stringify(manifest);
          manifestCache.set(key, normalized, TTL.META_IMMUTABLE);
          await setDiskCache("site", sig, Buffer.from(normalized));
          return manifest;
        }
      }
    } catch {}
  }

  const { data } = await readAsset(sig);
  if (!data) throw new Error("manifest not found");

  const decoded = decodeAssetData(data);
  const text = decoded.toString("utf-8");
  const raw = JSON.parse(text);
  const manifest = parseManifest(raw);

  if (Object.keys(manifest.files).length === 0) {
    throw new Error("invalid manifest: no files found");
  }

  const normalized = JSON.stringify(manifest);
  manifestCache.set(key, normalized, TTL.META_IMMUTABLE);
  await setDiskCache("site", sig, Buffer.from(normalized));
  return manifest;
}

async function fetchFile(sig: string): Promise<Buffer> {
  const key = `file:${sig}`;
  const cached = fileCache.get(key);
  if (cached) return cached;

  const disk = await getDiskCache("site-file", sig);
  if (disk) {
    fileCache.set(key, disk, TTL.IMAGE);
    return disk;
  }

  const backfillData = await getDiskCache("meta", `data:${sig}`);
  if (backfillData) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(backfillData));
      if (parsed.data) {
        const buf = decodeAssetData(parsed.data);
        fileCache.set(key, buf, TTL.IMAGE);
        await setDiskCache("site-file", sig, buf);
        return buf;
      }
    } catch {}
  }

  return enqueueRead(async () => {
    const rechecked = fileCache.get(key);
    if (rechecked) return rechecked;

    const { data } = await readAsset(sig);
    if (!data) throw new Error("file not found");

    const buf = decodeAssetData(data);
    fileCache.set(key, buf, TTL.IMAGE);
    await setDiskCache("site-file", sig, buf);
    return buf;
  });
}

export function buildFileResponse(buf: Buffer, filePath: string): Response {
  const mime = getMimeType(filePath);
  const isImmutable = !filePath.endsWith(".html") && !filePath.endsWith(".htm");
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Cache-Control": isImmutable
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      ETag: generateETag(buf),
    },
  });
}

export function resolveFile(manifest: Manifest, filePath: string): string | null {
  let p = filePath;
  if (!p || p === "/") p = manifest.indexPath;
  if (p.startsWith("/")) p = p.slice(1);
  return manifest.files[p] ?? null;
}

// Request-scoped helper. No globals. Each call serves files from the manifest
// passed in — never from any prior request's manifest.
export async function serveManifestPath(input: {
  manifestSig: string;
  filePath: string;
  indexPath?: string;
  spaFallback?: boolean;
  ifNoneMatch?: string | null;
}): Promise<Response> {
  const { manifestSig, filePath, indexPath, spaFallback, ifNoneMatch } = input;

  let manifest: Manifest;
  try {
    manifest = await fetchManifest(manifestSig);
  } catch (e) {
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

  const directTxId = resolveFile(lookupManifest, filePath);
  let targetTxId: string | null = directTxId;
  let servePath: string;
  if (directTxId) {
    servePath = filePath === "" || filePath === "/"
      ? effectiveIndex
      : (filePath.startsWith("/") ? filePath.slice(1) : filePath);
  } else if (spaFallback) {
    targetTxId = resolveFile(lookupManifest, effectiveIndex);
    servePath = effectiveIndex;
  } else {
    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
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

  const res = buildFileResponse(buf, servePath);
  const etag = res.headers.get("ETag");
  if (etag && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return res;
}

// GET /site/:manifestSig          -> serves index
// GET /site/:manifestSig/*path    -> serves file at path
// SPA fallback on miss matches the legacy behavior.
siteRouter.get("/:sig{.+}", async (c) => {
  const raw = c.req.param("sig");
  const slashIdx = raw.indexOf("/");
  const manifestSig = slashIdx > 0 ? raw.slice(0, slashIdx) : raw;
  const filePath = slashIdx > 0 ? raw.slice(slashIdx + 1) : "";

  if (manifestSig.length < 80) {
    return c.text("invalid manifest signature", 400);
  }

  const response = await serveManifestPath({
    manifestSig,
    filePath,
    spaFallback: true,
    ifNoneMatch: c.req.header("If-None-Match") ?? null,
  });

  if (response.status === 304) return c.body(null, 304);

  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  const body = await response.arrayBuffer();
  return c.body(body, response.status as 200, headers);
});
