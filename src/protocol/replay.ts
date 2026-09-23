export class ReplayGuard {
  // Insertion order equals expiry order because every entry gets the same TTL,
  // which lets prune() stop at the first live entry.
  private readonly expiries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  // True the first time a key is seen within the TTL; false for a repeat.
  // When full it returns false (fail closed) instead of evicting live entries,
  // since eviction would reopen a replay window.
  checkAndRemember(key: string, now: number): boolean {
    this.prune(now);
    if (this.expiries.has(key)) return false;
    if (this.expiries.size >= this.maxEntries) return false;
    this.expiries.set(key, now + this.ttlMs);
    return true;
  }

  get size(): number {
    return this.expiries.size;
  }

  private prune(now: number): void {
    for (const [key, expiry] of this.expiries) {
      if (expiry > now) break;
      this.expiries.delete(key);
    }
  }
}
