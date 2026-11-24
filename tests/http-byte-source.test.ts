import { expect, test } from "bun:test";
import { serveByteSource } from "../src/http-byte-source";
import { MemoryBudget } from "../src/memory-budget";

const headers = { contentType: "application/octet-stream" };

test("a buffered range holds its memory budget while preparing and draining", async () => {
  const budget = new MemoryBudget(16);
  const { promise, resolve } = Promise.withResolvers<void>();
  const data = Uint8Array.from({ length: 12 }, (_, index) => index);
  const source = {
    byteLength: data.length, blockSize: 4,
    async read(start: number, end: number) { await promise; return data.subarray(start, end); },
  };
  const first = serveByteSource(source, { ...headers, range: "bytes=0-7" }, budget);
  const busy = await serveByteSource(source, { ...headers, range: "bytes=1-8" }, budget);
  expect(busy.status).toBe(503);
  expect(busy.headers.get("Retry-After")).toBe("2");
  resolve();
  const response = await first;
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Length")).toBe("8");
  expect((await serveByteSource(source, { ...headers, range: "bytes=1-8" }, budget)).status).toBe(503);
  const reader = response.body!.getReader();
  expect((await reader.read()).value).toEqual(data.subarray(0, 4));
  expect((await serveByteSource(source, { ...headers, range: "bytes=1-8" }, budget)).status).toBe(503);
  expect((await reader.read()).value).toEqual(data.subarray(4, 8));
  expect((await reader.read()).done).toBeTrue();
  const next = await serveByteSource(source, { ...headers, range: "bytes=1-8" }, budget);
  expect(next.status).toBe(206);
  expect(new Uint8Array(await next.arrayBuffer())).toEqual(data.subarray(1, 9));
});

test("canceling or aborting a buffered range releases its reservation", async () => {
  const budget = new MemoryBudget(16);
  const range = { ...headers, range: "bytes=0-7" };
  const source = {
    byteLength: 8, blockSize: 4,
    async read(start: number, end: number) { return new Uint8Array(end - start); },
  };
  const response = await serveByteSource(source, range, budget);
  await response.body!.cancel();
  const control = new AbortController();
  const pending = await serveByteSource(source, { ...range, signal: control.signal }, budget);
  expect(pending.status).toBe(206);
  control.abort();
  await expect(pending.bytes()).rejects.toThrow();
  const next = await serveByteSource(source, range, budget);
  expect(next.status).toBe(206);
  expect(await next.bytes()).toHaveLength(8);
});

test("completed and cancelled streams release the read window and HEAD uses no read window", async () => {
  const budget = new MemoryBudget(8);
  let reads = 0;
  const source = {
    byteLength: 8, blockSize: 4,
    async read(start: number, end: number) { reads++; return new Uint8Array(end - start).fill(97); },
  };
  const response = await serveByteSource(source, headers, budget);
  const head = await serveByteSource(source, { ...headers, method: "HEAD" }, budget);
  expect(head.headers.get("Content-Length")).toBe("8");
  expect(reads).toBe(1);
  expect((await serveByteSource(source, headers, budget)).status).toBe(503);
  await response.body?.cancel();
  const next = await serveByteSource(source, headers, budget);
  expect(await next.text()).toBe("aaaaaaaa");
  expect((await serveByteSource(source, { ...headers, range: "bytes=8-" }, budget)).status).toBe(416);
  const release = budget.tryReserve(8);
  expect(release).toBeFunction();
  release?.();
});
