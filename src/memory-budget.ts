export class MemoryBudget {
  private reserved = 0;

  constructor(readonly limit: number) {}

  tryReserve(bytes: number): (() => void) | undefined {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.limit - this.reserved) return;
    this.reserved += bytes;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.reserved -= bytes;
    };
  }
}
