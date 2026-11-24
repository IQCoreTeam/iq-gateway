import { createHash } from "node:crypto";
import { deduped } from "./cache/dedup";
import { MemoryCache, TTL } from "./cache/memory";
import type { VerifiedObjectDiskCache } from "./cache/verified-objects";
import { decodeCodeInObject, MAX_CODE_IN_OBJECT_BYTES } from "./chain/solana/code-in-object";
import type { HttpByteSource } from "./http-byte-source";
import { MemoryBudget } from "./memory-budget";
import { isSolanaSignature } from "./utils";

const FANOUT = 128;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface ObjectRef { id: string; sha256: string }

export interface ChunkedSiteFile {
  version: 1;
  bytes: number;
  chunkBytes: number;
  index: ObjectRef;
}

export class SiteChunkError extends Error {
  constructor(readonly status: 404 | 422 | 502 | 503, message: string) { super(message); }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : undefined;
}

function objectRef(input: unknown): ObjectRef | undefined {
  const value = record(input);
  if (!value || !isSolanaSignature(value.id) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    return undefined;
  }
  return { id: value.id, sha256: value.sha256 };
}

export function parseChunkedSiteFile(input: unknown): ChunkedSiteFile | undefined {
  const value = record(input);
  if (!value || value.version !== 1 || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0 || typeof value.chunkBytes !== "number" || !Number.isInteger(value.chunkBytes)
    || value.chunkBytes <= 0 || value.chunkBytes > MAX_CODE_IN_OBJECT_BYTES) return undefined;
  const index = objectRef(value.index);
  return index ? { version: 1, bytes: value.bytes, chunkBytes: value.chunkBytes, index } : undefined;
}

function verifyObject(data: string, digest: string) {
  try {
    const bytes = decodeCodeInObject(data);
    return createHash("sha256").update(bytes).digest("hex") === digest ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export class SiteChunkStore {
  private readonly indices = new MemoryCache<ObjectRef[]>(64);
  private readonly chunks = new MemoryCache<Buffer>(64);
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly readMemory = new MemoryBudget(32 * 1024 * 1024);

  constructor(private readonly readAsset: (id: string) => Promise<{ data: string | null }>,
    private readonly disk?: VerifiedObjectDiskCache,
    private readonly readCachedData?: (id: string) => Promise<string | null>) {}

  source(file: ChunkedSiteFile): HttpByteSource {
    const { bytes, chunkBytes } = file;
    const count = Math.ceil(bytes / chunkBytes);
    let rootSpan = 1;
    while (Math.ceil(count / rootSpan) > FANOUT) rootSpan *= FANOUT;

    return {
      byteLength: bytes, blockSize: chunkBytes,
      read: async (start, end) => {
        const chunk = Math.floor(start / chunkBytes);
        const offset = start % chunkBytes;
        const length = Math.min(chunkBytes, bytes - chunk * chunkBytes);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > bytes
          || end <= start || offset + end - start > length) throw new SiteChunkError(422, "Invalid chunk window");

        let reference = file.index;
        let remaining = chunk;
        let entries = count;
        for (let span = rootSpan;; span /= FANOUT) {
          const expected = Math.ceil(entries / span);
          const nodes = await this.readIndex(reference, expected);
          const child = Math.floor(remaining / span);
          reference = nodes[child];
          if (span === 1) break;
          remaining %= span;
          entries = Math.min(span, entries - child * span);
        }
        const data = await this.readChunk(reference, length);
        return data.subarray(offset, offset + end - start);
      },
    };
  }

  private readIndex(reference: ObjectRef, expected: number) {
    const key = `index:${reference.id}:${reference.sha256}:${expected}`;
    return this.indices.get(key) ?? this.readOnce(key, async () => {
      const raw = await this.readVerified(reference);
      try {
        const input: unknown = JSON.parse(decoder.decode(raw));
        if (!Array.isArray(input) || input.length !== expected) throw new Error();
        const refs = input.map(entry => {
          const ref = objectRef(entry);
          if (!ref) throw new Error();
          return ref;
        });
        this.indices.set(key, refs, TTL.META_IMMUTABLE);
        return refs;
      } catch {
        throw new SiteChunkError(422, "Invalid chunk index");
      }
    });
  }

  private readChunk(reference: ObjectRef, expected: number) {
    const key = `chunk:${reference.id}:${reference.sha256}:${expected}`;
    return this.chunks.get(key) ?? this.readOnce(key, async () => {
      const data = await this.readVerified(reference);
      if (data.length !== expected) throw new SiteChunkError(422, "Invalid chunk length");
      this.chunks.set(key, data, TTL.META_IMMUTABLE);
      return data;
    });
  }

  private readOnce<T>(key: string, read: () => Promise<T>) {
    return deduped(this.pending, key, async () => {
      const release = this.readMemory.tryReserve(4 * MAX_CODE_IN_OBJECT_BYTES);
      if (!release) throw new SiteChunkError(503, "Chunk reader is busy");
      try { return await read(); }
      finally { release(); }
    });
  }

  private async readVerified(reference: ObjectRef) {
    const cached = await this.disk?.get(reference.id, reference.sha256);
    if (cached) return cached;
    const backfill = await this.readCachedData?.(reference.id);
    let bytes = backfill ? verifyObject(backfill, reference.sha256) : undefined;
    if (!bytes) {
      let data: string | null;
      try { ({ data } = await this.readAsset(reference.id)); }
      catch { throw new SiteChunkError(502, "Could not read the Code-In object"); }
      if (!data) throw new SiteChunkError(404, "Code-In object is missing");
      bytes = verifyObject(data, reference.sha256);
      if (!bytes) throw new SiteChunkError(422, "Code-In object failed verification");
    }
    await this.disk?.put(reference.id, reference.sha256, bytes);
    return bytes;
  }
}
