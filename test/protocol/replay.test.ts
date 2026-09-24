import { describe, expect, test } from "vitest";
import { ReplayGuard } from "../../src/protocol/replay.js";

describe("ReplayGuard", () => {
  test("accepts once, rejects repeats within the TTL", () => {
    const guard = new ReplayGuard(1000);
    expect(guard.checkAndRemember("a", 0)).toBe(true);
    expect(guard.checkAndRemember("a", 999)).toBe(false);
    expect(guard.checkAndRemember("b", 999)).toBe(true);
  });

  test("forgets keys after the TTL and prunes them", () => {
    const guard = new ReplayGuard(1000);
    guard.checkAndRemember("a", 0);
    expect(guard.checkAndRemember("a", 1000)).toBe(true);
    expect(guard.size).toBe(1);
  });

  test("fails closed when full instead of evicting live entries", () => {
    const guard = new ReplayGuard(1000, 2);
    expect(guard.checkAndRemember("a", 0)).toBe(true);
    expect(guard.checkAndRemember("b", 0)).toBe(true);
    expect(guard.checkAndRemember("c", 0)).toBe(false);
    expect(guard.checkAndRemember("a", 1)).toBe(false);
    expect(guard.checkAndRemember("c", 1000)).toBe(true);
  });

  test("rejects a non-finite or non-positive ttlMs", () => {
    // A NaN/zero/negative TTL would silently disable the replay window
    // (every entry expires immediately, or the prune math breaks), which is
    // a local wiring bug, not something to fail open on.
    expect(() => new ReplayGuard(Number.NaN)).toThrow(RangeError);
    expect(() => new ReplayGuard(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => new ReplayGuard(0)).toThrow(RangeError);
    expect(() => new ReplayGuard(-1)).toThrow(RangeError);
  });

  test("rejects a non-positive or non-integer maxEntries", () => {
    expect(() => new ReplayGuard(1000, 0)).toThrow(RangeError);
    expect(() => new ReplayGuard(1000, -1)).toThrow(RangeError);
    expect(() => new ReplayGuard(1000, 1.5)).toThrow(RangeError);
    expect(() => new ReplayGuard(1000, Number.NaN)).toThrow(RangeError);
  });

  test("admit tells a repeat apart from a full cache", () => {
    const guard = new ReplayGuard(1000, 1);
    expect(guard.admit("a", 0)).toBe("new");
    expect(guard.admit("a", 1)).toBe("seen");
    expect(guard.admit("b", 1)).toBe("full");
    expect(guard.admit("b", 1000)).toBe("new");
  });
});
