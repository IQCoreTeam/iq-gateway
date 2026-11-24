// Parse one inclusive byte range. A missing or invalid header returns null;
// the route decides whether to send the full response or reject the range.
export function parseRange(range: string | null | undefined, size: number): { start: number; end: number } | null {
  if (!range || !Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d{0,32})-(\d{0,32})$/i.exec(range.trim());
  if (!match) return null;
  const [, left, right] = match;
  if (left === "") {
    const suffix = Number(right);
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(left);
  const end = right === "" ? size - 1 : Math.min(Number(right), size - 1);
  return start <= end ? { start, end } : null;
}
