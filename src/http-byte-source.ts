import { parseRange } from "./http-range";
import { MemoryBudget } from "./memory-budget";

const MAX_FIXED_RANGE = 16 * 1024 * 1024;
const responseMemory = new MemoryBudget(96 * 1024 * 1024);

export interface HttpByteSource {
  byteLength: number;
  blockSize: number;
  read(start: number, endExclusive: number): Promise<Uint8Array>;
}

export function busyByteResponse() {
  return new Response("Byte source is busy. Retry shortly.", {
    status: 503, headers: { "Retry-After": "2", "Cache-Control": "no-store" },
  });
}

export async function serveByteSource(source: HttpByteSource, request: {
  range?: string | null;
  signal?: AbortSignal;
  method?: string;
  contentType: string;
}, budget = responseMemory): Promise<Response> {
  const { byteLength: total, blockSize } = source;
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new Error("Invalid byte source size.");
  }
  const partial = parseRange(request.range, total);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": request.contentType,
  });
  if (request.range && !partial) {
    headers.set("Content-Range", `bytes */${total}`);
    return new Response(null, { status: 416, headers });
  }
  let cursor = partial?.start ?? 0;
  const end = partial ? partial.end + 1 : total;
  const length = end - cursor;
  const status = partial ? 206 : 200;
  headers.set("Content-Length", String(length));
  if (partial) headers.set("Content-Range", `bytes ${partial.start}-${partial.end}/${total}`);
  if (request.method === "HEAD" || !length) return new Response(null, { status, headers });

  const bufferRange = partial !== null && length <= MAX_FIXED_RANGE;
  const windowBytes = Math.min(blockSize, length);
  // Reserve the buffered range and two windows for reading and sending bytes.
  const release = budget.tryReserve(2 * windowBytes + (bufferRange ? length : 0));
  if (!release) return busyByteResponse();
  async function next() {
    request.signal?.throwIfAborted();
    const limit = Math.min(end, cursor + blockSize - cursor % blockSize);
    const data = await source.read(cursor, limit);
    request.signal?.throwIfAborted();
    if (data.byteLength !== limit - cursor) throw new Error("Byte source returned an incomplete read.");
    cursor = limit;
    return data;
  }
  let prefetched: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (bufferRange) {
      prefetched = new Uint8Array(length);
      const start = cursor;
      while (cursor < end) {
        const offset = cursor - start;
        prefetched.set(await next(), offset);
      }
    } else {
      prefetched = Uint8Array.from(await next());
    }
  } catch (error) {
    release();
    throw error;
  }
  let sent = 0;
  let reading = false;
  let cancelled = false;
  function close() {
    request.signal?.removeEventListener("abort", cancel);
    prefetched = undefined;
    release();
  }
  function cancel() {
    cancelled = true;
    if (!reading) close();
  }
  const payload = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      reading = true;
      try {
        if (cancelled) throw request.signal?.reason ?? new Error("Byte source cancelled.");
        const bytes = bufferRange
          ? prefetched!.slice(sent, sent + windowBytes)
          : prefetched ?? Uint8Array.from(await next());
        if (!bufferRange) prefetched = undefined;
        sent += bytes.byteLength;
        controller.enqueue(bytes);
        if (sent === length) {
          controller.close();
          cancelled = true;
        }
      } catch (error) {
        cancelled = true;
        throw error;
      } finally {
        reading = false;
        if (cancelled) close();
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  request.signal?.addEventListener("abort", cancel, { once: true });
  if (request.signal?.aborted) cancel();
  return new Response(payload, { status, headers });
}
