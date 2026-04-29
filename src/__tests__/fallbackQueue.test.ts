import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFallbackQueue } from "../fallbackQueue";
import type { InternalLogger } from "../logger";

function mockLogger(): InternalLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  };
}

describe("fallbackQueue", () => {
  let logger: InternalLogger;

  beforeEach(() => {
    logger = mockLogger();
  });

  it("resolves on first URL success", async () => {
    const queue = createFallbackQueue(["url-a", "url-b"], "test", logger);
    const result = await queue.push(async (url) => {
      if (url === "url-a") return "success-a";
      return "success-b";
    });
    expect(result).toBe("success-a");

    const stats = queue.getStats();
    expect(stats.totalQueued).toBe(1);
    expect(stats.totalResolved).toBe(1);
  });

  it("tries next URL on failure, returns first success", async () => {
    const queue = createFallbackQueue(["url-a", "url-b"], "test", logger);
    const result = await queue.push(async (url) => {
      if (url === "url-a") throw new Error("failed");
      return "success-b";
    });
    expect(result).toBe("success-b");
  });

  it("rejects when all URLs fail", async () => {
    const queue = createFallbackQueue(["url-a", "url-b"], "test", logger);
    await expect(
      queue.push(async () => { throw new Error("failed"); }),
    ).rejects.toThrow();

    const stats = queue.getStats();
    expect(stats.totalFailed).toBe(1);
  });

  it("rejects when queue is full", async () => {
    const queue = createFallbackQueue(["url-a"], "test", logger, {
      maxSize: 2,
      concurrency: 1,
    });

    // First request starts processing (pending=1, size=0)
    const slow1 = queue.push(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return "slow1";
    });

    // Second request waits in queue (pending=1, size=1)
    const slow2 = queue.push(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return "slow2";
    });

    // Third request also waits (pending=1, size=2) → should be rejected
    await expect(
      queue.push(async () => "fast"),
    ).rejects.toThrow("Queue full");

    // Clean up
    await slow1;
    await slow2;

    const stats = queue.getStats();
    expect(stats.totalRejected).toBe(1);
  });

  it("times out after totalTimeoutMs", async () => {
    const queue = createFallbackQueue(["url-a"], "test", logger, {
      totalTimeoutMs: 100,
    });

    await expect(
      queue.push(async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "too-slow";
      }, 100),
    ).rejects.toThrow("Total timeout");

    const stats = queue.getStats();
    expect(stats.totalTimedOut).toBe(1);
  });

  it("warns when no paid URLs provided", () => {
    createFallbackQueue([], "test", logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No paid RPC URLs"),
    );
  });

  it("tracks stats accurately", async () => {
    const queue = createFallbackQueue(["url-a"], "test", logger);
    await queue.push(async () => "ok");
    await queue.push(async () => "ok");

    const stats = queue.getStats();
    expect(stats.totalQueued).toBe(2);
    expect(stats.totalResolved).toBe(2);
    expect(stats.totalRejected).toBe(0);
    expect(stats.totalTimedOut).toBe(0);
    expect(stats.totalFailed).toBe(0);
    expect(stats.maxSize).toBe(50); // default
  });

  it("respects custom concurrency", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const queue = createFallbackQueue(["url-a"], "test", logger, {
      concurrency: 2,
    });

    const tasks = Array.from({ length: 5 }, () =>
      queue.push(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
        return "ok";
      }),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
