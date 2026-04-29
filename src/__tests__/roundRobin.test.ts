import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoundRobinPool } from "../roundRobin";
import type { InternalLogger } from "../logger";

function mockLogger(): InternalLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  };
}

describe("roundRobin", () => {
  let logger: InternalLogger;

  beforeEach(() => {
    logger = mockLogger();
  });

  it("throws if no URLs provided", () => {
    expect(() => createRoundRobinPool([], logger)).toThrow("No RPC URLs");
  });

  it("rotates through URLs in order", () => {
    const pool = createRoundRobinPool(["a", "b", "c"], logger, { startIndex: 0 });
    expect(pool.next()).toBe("a");
    expect(pool.next()).toBe("b");
    expect(pool.next()).toBe("c");
    expect(pool.next()).toBe("a"); // wraps around
  });

  it("randomises the start cursor by default", () => {
    // Spread across many fresh pools — at least two starts must differ.
    const starts = new Set(
      Array.from({ length: 30 }, () => createRoundRobinPool(["a", "b", "c", "d"], logger).next()),
    );
    expect(starts.size).toBeGreaterThan(1);
  });

  it("evicts after N consecutive failures", () => {
    const pool = createRoundRobinPool(["a", "b"], logger, {
      startIndex: 0,
      failureThreshold: 2,
      cooldownMs: 60_000,
    });

    // "a" gets 2 failures
    const url = pool.next(); // "a"
    pool.failure(url);
    pool.failure(url); // 2nd → evicted

    expect(pool.next()).toBe("b");
    expect(pool.next()).toBe("b"); // "a" is evicted, skipped
  });

  it("resets failure count on success", () => {
    const pool = createRoundRobinPool(["a", "b"], logger, {
      failureThreshold: 3,
    });

    pool.failure("a");
    pool.failure("a");
    pool.success("a"); // reset
    pool.failure("a");
    pool.failure("a");
    // Only 2 consecutive, not 3 — "a" should not be evicted

    const stats = pool.getStats();
    expect(stats.evicted).toHaveLength(0);
  });

  it("auto-heals after cooldown", () => {
    vi.useFakeTimers();
    const pool = createRoundRobinPool(["a", "b"], logger, {
      startIndex: 0,
      failureThreshold: 1,
      cooldownMs: 1000,
    });

    pool.failure("a"); // evicted
    expect(pool.next()).toBe("b"); // skip "a"

    vi.advanceTimersByTime(1100);
    // After cooldown, "a" should be re-added on next rotation
    // Since currentIndex wraps, we need to cycle through
    const urls = [pool.next(), pool.next()];
    expect(urls).toContain("a");
    vi.useRealTimers();
  });

  it("falls through when all URLs evicted", () => {
    const pool = createRoundRobinPool(["a", "b"], logger, {
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    pool.failure("a");
    pool.failure("b");

    // Should still return something (best-effort)
    const url = pool.next();
    expect(["a", "b"]).toContain(url);
  });

  it("tracks stats accurately", () => {
    const pool = createRoundRobinPool(["a", "b"], logger, { startIndex: 0 });

    pool.next(); // "a" → request counted
    pool.success("a");
    pool.next(); // "b" → request counted
    pool.failure("b");

    const stats = pool.getStats();
    expect(stats.urls).toEqual(["a", "b"]);
    expect(stats.totalRequests["a"]).toBe(1);
    expect(stats.totalSuccesses["a"]).toBe(1);
    expect(stats.totalRequests["b"]).toBe(1);
    expect(stats.totalFailures["b"]).toBe(1);
  });

  it("reset() restores all evicted URLs without clearing cumulative counters", () => {
    const pool = createRoundRobinPool(["a", "b"], logger, {
      startIndex: 0,
      failureThreshold: 1,
      cooldownMs: 60_000,
    });

    pool.failure("a"); // evicted
    pool.failure("b"); // evicted
    expect(pool.getStats().evicted).toHaveLength(2);
    expect(pool.getStats().totalFailures["a"]).toBe(1);

    pool.reset();
    expect(pool.getStats().evicted).toHaveLength(0);
    expect(pool.getStats().failures).toEqual({});
    // Cumulative counters are preserved.
    expect(pool.getStats().totalFailures["a"]).toBe(1);
    expect(pool.getStats().totalFailures["b"]).toBe(1);
  });

  it("uses configurable options", () => {
    const pool = createRoundRobinPool(["a"], logger, {
      chainName: "polygon",
      failureThreshold: 10,
      cooldownMs: 999,
    });

    // Should need 10 failures to evict
    for (let i = 0; i < 9; i++) pool.failure("a");
    expect(pool.getStats().evicted).toHaveLength(0);
    pool.failure("a"); // 10th
    expect(pool.getStats().evicted).toHaveLength(1);
  });
});
