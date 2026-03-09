// Inflight request deduplication.
// Prevents thundering herd: concurrent requests for the same key share one promise.

export function deduped(
  inflight: Map<string, Promise<string>>,
  key: string,
  fn: () => Promise<string>,
): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
