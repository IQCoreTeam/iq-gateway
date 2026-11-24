import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CODE_IN_OBJECT_BYTES } from "../chain/solana/code-in-object";

const DEFAULT_BYTES = 256 * 1024 * 1024;
const DEFAULT_ENTRIES = 2048;
const BYTES_PER_ENTRY = 128 * 1024;
const objectName = /^[a-f0-9]{64}\.bin$/;
const temporaryName = /^[a-f0-9]{64}\.bin\.tmp$/;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function unlinkIfPresent(path: string) {
  try { await unlink(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** One cache directory per gateway instance, retained across restarts. */
export class VerifiedObjectDiskCache {
  private readonly entries = new Map<string, number>();
  private bytes = 0;
  private initialized = false;
  private tail = Promise.resolve();
  private readonly maxEntries: number;

  constructor(private readonly directory: string, private readonly maxBytes: number) {
    this.maxEntries = Math.max(DEFAULT_ENTRIES, Math.floor(maxBytes / BYTES_PER_ENTRY));
  }

  get(id: string, sha256: string): Promise<Buffer | undefined> {
    const name = this.fileName(id, sha256);
    return this.run(async () => {
      const entrySize = this.entries.get(name);
      if (entrySize === undefined) return;
      const path = join(this.directory, name);
      let verified: Buffer | undefined;
      try {
        const file = await open(path, "r");
        try {
          const { size } = await file.stat();
          if (size > 0 && size <= MAX_CODE_IN_OBJECT_BYTES && size === entrySize) {
            const result = Buffer.allocUnsafe(size);
            const { bytesRead } = await file.read(result, 0, size, 0);
            if (bytesRead === size && digest(result) === sha256) verified = result;
          }
        } finally {
          await file.close();
        }
      } catch { /* Treat an inaccessible object as a cache miss. */ }
      if (!verified) {
        await this.remove(name);
        return;
      }
      this.entries.delete(name);
      this.entries.set(name, entrySize);
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return verified;
    });
  }

  async put(id: string, sha256: string, bytes: Buffer): Promise<void> {
    if (!bytes.length || bytes.length > MAX_CODE_IN_OBJECT_BYTES || bytes.length > this.maxBytes) return;
    if (digest(bytes) !== sha256) return;
    const name = this.fileName(id, sha256);
    await this.run(async () => {
      if (this.entries.has(name)) return;
      await this.trim(bytes.length, 1);
      const path = join(this.directory, name);
      const temporary = path + ".tmp";
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, path);
        this.entries.set(name, bytes.length);
        this.bytes += bytes.length;
      } catch (error) {
        await unlinkIfPresent(temporary);
        throw error;
      }
    });
  }

  private fileName(id: string, sha256: string) {
    return createHash("sha256").update(id + ":" + sha256).digest("hex") + ".bin";
  }

  private async remove(name: string) {
    await unlinkIfPresent(join(this.directory, name));
    this.bytes -= this.entries.get(name) ?? 0;
    this.entries.delete(name);
  }

  private async trim(incomingBytes: number, incomingEntries: number) {
    for (const name of this.entries.keys()) {
      if (this.bytes + incomingBytes <= this.maxBytes && this.entries.size + incomingEntries <= this.maxEntries) break;
      await this.remove(name);
    }
  }

  private async initialize() {
    await mkdir(this.directory, { recursive: true });
    const objects: { name: string; size: number; accessed: number }[] = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(this.directory, entry.name);
      if (temporaryName.test(entry.name)) {
        await unlinkIfPresent(path);
        continue;
      }
      if (!objectName.test(entry.name)) continue;
      const { size, mtimeMs } = await stat(path);
      if (!size || size > MAX_CODE_IN_OBJECT_BYTES) {
        await unlinkIfPresent(path);
        continue;
      }
      objects.push({ name: entry.name, size, accessed: mtimeMs });
    }
    this.entries.clear();
    this.bytes = 0;
    for (const { name, size } of objects.sort((a, b) => a.accessed - b.accessed)) {
      this.entries.set(name, size);
      this.bytes += size;
    }
    await this.trim(0, 0);
    this.initialized = true;
  }

  private run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!this.maxBytes) return Promise.resolve(undefined);
    const work = this.tail.then(async () => {
      if (!this.initialized) await this.initialize();
      return operation();
    });
    this.tail = work.then(() => {}, () => {});
    return work.catch(() => undefined);
  }
}

const configured = process.env.SITE_CHUNK_CACHE_BYTES;
const capacity = configured === undefined ? DEFAULT_BYTES : Number(configured);
export const verifiedObjectDiskCache = new VerifiedObjectDiskCache(
  join(process.env.CACHE_DIR || "./cache", "site-verified-objects"),
  Number.isSafeInteger(capacity) && capacity >= 0 ? capacity : DEFAULT_BYTES,
);
