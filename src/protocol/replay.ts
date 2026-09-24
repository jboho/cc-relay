// "full" is distinct from "seen" so a caller can tell an attack on the cache
// (or a sizing bug) apart from an actual replay; both still fail closed.
export type Admission = "new" | "seen" | "full";

export class ReplayGuard {
  // Insertion order equals expiry order because every entry gets the same TTL,
  // which lets prune() stop at the first live entry.
  private readonly expiries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {
    // A NaN/zero/negative TTL silently reopens the replay window: prune()'s
    // `expiry > now` check and admit's `now + ttlMs` both go wrong in ways
    // that let every entry through immediately, rather than failing loudly.
    // Both are our own config, never caller-supplied peer data, so this
    // must throw rather than fail open.
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("ReplayGuard: ttlMs must be a finite number > 0");
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("ReplayGuard: maxEntries must be a positive integer");
    }
  }

  // "new" the first time a key is seen within the TTL, "seen" for a repeat.
  // When full it returns "full" (fail closed) instead of evicting live
  // entries, since eviction would reopen a replay window.
  admit(key: string, now: number): Admission {
    this.prune(now);
    if (this.expiries.has(key)) return "seen";
    if (this.expiries.size >= this.maxEntries) return "full";
    this.expiries.set(key, now + this.ttlMs);
    return "new";
  }

  checkAndRemember(key: string, now: number): boolean {
    return this.admit(key, now) === "new";
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
