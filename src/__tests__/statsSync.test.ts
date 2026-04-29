import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatsSync, readAllWorkerStats } from "../statsSync";
import type { TransportStats } from "../types";

/**
 * End-to-end tests for the worker → main thread stats bridge. We don't spin up
 * real worker_threads here — instead we run two `createStatsSync` instances
 * in-process pointing at a shared tempdir to simulate the multi-worker case.
 */

function makeStats(chain: string, requests: number): TransportStats {
  return {
    chain,
    circuitBreaker: { state: "CLOSED", consecutiveFailures: 0, lastFailureTime: 0, cooldownMs: 30_000 },
    fallbackQueue: {
      size: 0, pending: 0, maxSize: 50,
      totalQueued: 0, totalResolved: 0, totalRejected: 0, totalTimedOut: 0, totalFailed: 0,
    },
    publicPool: { urls: [], evicted: [], failures: {}, totalRequests: {}, totalSuccesses: {}, totalFailures: {} },
    hyperSyncPool: null,
    paidUrls: [],
    tierCounters: {
      hyperSync: { requests: 0, successes: 0, failures: 0 },
      public:    { requests, successes: requests, failures: 0 },
      paid:      { requests: 0, successes: 0, failures: 0 },
      queue:     { requests: 0, successes: 0, failures: 0 },
    },
    methodCounters: {},
  };
}

describe("statsSync", () => {
  let statsDir: string;

  beforeEach(async () => {
    statsDir = await mkdtemp(join(tmpdir(), "prism-statssync-"));
  });

  afterEach(async () => {
    await rm(statsDir, { recursive: true, force: true });
  });

  it("flushes a worker's stats and another reader can pick them up", async () => {
    const sync = createStatsSync({ statsDir, writeIntervalMs: 60_000 });
    sync.registerProvider("polygon", () => makeStats("polygon", 7));
    sync.start();
    // start() does an immediate flush; wait a tick for the write+rename to land.
    await vi.waitFor(async () => {
      const stats = await readAllWorkerStats({ statsDir });
      expect(stats).toHaveLength(1);
    });
    const stats = await readAllWorkerStats({ statsDir });
    expect(stats[0]?.chain).toBe("polygon");
    expect(stats[0]?.tierCounters.public.requests).toBe(7);
    sync.dispose();
  });

  it("picks the worker with the highest total request count per chain", async () => {
    const sync1 = createStatsSync({ statsDir, writeIntervalMs: 60_000 });
    sync1.registerProvider("polygon", () => makeStats("polygon", 3));
    sync1.start();

    const sync2 = createStatsSync({ statsDir, writeIntervalMs: 60_000 });
    sync2.registerProvider("polygon", () => makeStats("polygon", 42));
    sync2.start();

    await vi.waitFor(async () => {
      const stats = await readAllWorkerStats({ statsDir });
      expect(stats[0]?.tierCounters.public.requests).toBe(42);
    });

    sync1.dispose();
    sync2.dispose();
  });

  it("rejects malformed JSON files instead of trusting them", async () => {
    // Drop a malicious file that looks valid but lacks tierCounters.
    await writeFile(
      join(statsDir, "evil.json"),
      JSON.stringify({ ts: Date.now(), chains: { polygon: { tierCounters: null } } }),
    );
    // Drop a totally garbage file.
    await writeFile(join(statsDir, "garbage.json"), "{not json");

    const stats = await readAllWorkerStats({ statsDir });
    expect(stats).toEqual([]);
  });

  it("deletes stale files on read", async () => {
    const stale = JSON.stringify({
      ts: Date.now() - 10 * 60_000,
      chains: { polygon: makeStats("polygon", 1) },
    });
    const stalePath = join(statsDir, "stale.json");
    await writeFile(stalePath, stale);

    const stats = await readAllWorkerStats({ statsDir, staleMs: 1000 });
    expect(stats).toEqual([]);
    // File should be cleaned up after the read.
    await vi.waitFor(async () => {
      const { readdir } = await import("node:fs/promises");
      const remaining = await readdir(statsDir);
      expect(remaining).not.toContain("stale.json");
    });
  });

  it("returns an empty array when the stats dir does not exist", async () => {
    const stats = await readAllWorkerStats({ statsDir: join(statsDir, "does-not-exist", "nested") });
    // We mkdir-recursive on read, so an absent dir resolves to no files, not an error.
    expect(stats).toEqual([]);
  });
});
