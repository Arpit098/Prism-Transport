import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCircuitBreaker } from "../circuitBreaker";
import type { InternalLogger } from "../logger";

function mockLogger(): InternalLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  };
}

describe("circuitBreaker", () => {
  let logger: InternalLogger;

  beforeEach(() => {
    logger = mockLogger();
  });

  it("starts in CLOSED state", () => {
    const cb = createCircuitBreaker("test", logger);
    expect(cb.state).toBe("CLOSED");
    expect(cb.canRequest()).toBe(true);
  });

  it("stays CLOSED on success", () => {
    const cb = createCircuitBreaker("test", logger);
    cb.onSuccess();
    cb.onSuccess();
    expect(cb.state).toBe("CLOSED");
  });

  it("opens after failureThreshold consecutive failures", () => {
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 3 });
    cb.onFailure();
    expect(cb.state).toBe("CLOSED");
    cb.onFailure();
    expect(cb.state).toBe("CLOSED");
    cb.onFailure(); // 3rd failure
    expect(cb.state).toBe("OPEN");
    expect(cb.canRequest()).toBe(false);
  });

  it("rejects requests while OPEN", () => {
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 1 });
    cb.onFailure();
    expect(cb.state).toBe("OPEN");
    expect(cb.canRequest()).toBe(false);
    expect(cb.canRequest()).toBe(false);
  });

  it("transitions to HALF_OPEN after cooldown", () => {
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 1, cooldownMs: 100 });
    cb.onFailure();
    expect(cb.state).toBe("OPEN");

    // Fast-forward time
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");
    vi.useRealTimers();
  });

  it("transitions from HALF_OPEN to CLOSED on success", () => {
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 1, cooldownMs: 50 });
    cb.onFailure();

    vi.useFakeTimers();
    vi.advanceTimersByTime(60);
    cb.canRequest(); // transitions to HALF_OPEN
    expect(cb.state).toBe("HALF_OPEN");

    cb.onSuccess();
    expect(cb.state).toBe("CLOSED");
    expect(cb.canRequest()).toBe(true);
    vi.useRealTimers();
  });

  it("transitions from HALF_OPEN to OPEN on failure", () => {
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 1, cooldownMs: 50 });
    cb.onFailure();

    vi.useFakeTimers();
    vi.advanceTimersByTime(60);
    cb.canRequest(); // transitions to HALF_OPEN
    expect(cb.state).toBe("HALF_OPEN");

    cb.onFailure(); // probe failed
    expect(cb.state).toBe("OPEN");
    expect(cb.canRequest()).toBe(false);
    vi.useRealTimers();
  });

  it("resets consecutive failures on success", () => {
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 3 });
    cb.onFailure();
    cb.onFailure();
    cb.onSuccess(); // reset
    cb.onFailure();
    cb.onFailure();
    expect(cb.state).toBe("CLOSED"); // only 2 consecutive, not 3
  });

  it("getStats returns correct state", () => {
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 3, cooldownMs: 5000 });
    cb.onFailure();
    cb.onFailure();

    const stats = cb.getStats();
    expect(stats.state).toBe("CLOSED");
    expect(stats.consecutiveFailures).toBe(2);
    expect(stats.cooldownMs).toBe(5000);
    expect(stats.lastFailureTime).toBeGreaterThan(0);
  });

  it("uses default thresholds when no options given", () => {
    const cb = createCircuitBreaker("test", logger);
    // Should need 5 failures (default)
    for (let i = 0; i < 4; i++) cb.onFailure();
    expect(cb.state).toBe("CLOSED");
    cb.onFailure(); // 5th
    expect(cb.state).toBe("OPEN");
  });

  it("admits only one HALF_OPEN probe at a time", () => {
    vi.useFakeTimers();
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 1, cooldownMs: 50 });
    cb.onFailure();
    expect(cb.state).toBe("OPEN");

    vi.advanceTimersByTime(60);
    // First caller after cooldown gets the probe slot.
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("HALF_OPEN");
    // Concurrent callers are rejected until the probe resolves.
    expect(cb.canRequest()).toBe(false);
    expect(cb.canRequest()).toBe(false);

    cb.onSuccess();
    // Slot released; further requests proceed normally (state CLOSED).
    expect(cb.canRequest()).toBe(true);
    vi.useRealTimers();
  });

  it("re-grants the probe slot after onFailure reopens the circuit", () => {
    vi.useFakeTimers();
    const cb = createCircuitBreaker("test", logger, { failureThreshold: 1, cooldownMs: 50 });
    cb.onFailure();

    vi.advanceTimersByTime(60);
    expect(cb.canRequest()).toBe(true);   // probe slot taken
    expect(cb.canRequest()).toBe(false);  // others blocked
    cb.onFailure();                       // probe failed → OPEN
    expect(cb.state).toBe("OPEN");

    vi.advanceTimersByTime(60);
    expect(cb.canRequest()).toBe(true);   // next probe slot granted
    vi.useRealTimers();
  });
});
