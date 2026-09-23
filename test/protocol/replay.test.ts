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
});
