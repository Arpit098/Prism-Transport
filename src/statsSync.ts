import { writeFile, rename, readdir, readFile, unlink, mkdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TransportStats } from "./types";
import type { InternalLogger } from "./logger";

/**
 * File-based stats bridge for multi-worker / multi-thread environments.
 *
 * In threaded runtimes (e.g. Ponder's `worker_threads`) each worker holds its
 * own transport with separate in-memory counters. The main process — which
 * usually serves the HTTP/metrics surface — has no direct view into them.
 * This plugin lets each worker periodically write its stats to a temp file;
 * the main process then aggregates the files via {@link readAllWorkerStats}.
 *
 * Opt-in: nothing runs unless you call {@link createStatsSync} and `start()`.
 */

export interface StatsSyncOptions {
  /** Directory for stats files. @defaultValue `<tmpdir>/prism-transport-stats` */
  statsDir?: string;
  /** Flush interval in ms. @defaultValue 5_000 */
  writeIntervalMs?: number;
  /** Logger to receive flush errors. The first error is logged; subsequent ones are suppressed. */
  logger?: InternalLogger;
}

/**
 * Create a per-worker stats writer.
 *
 * @example
 * ```ts
 * // Inside a worker thread:
 * const sync = createStatsSync({ logger });
 * sync.registerProvider("polygon", getStats);
 * sync.start();
 * ```
 */
export function createStatsSync(options: StatsSyncOptions = {}) {
  const statsDir        = options.statsDir        ?? join(tmpdir(), "prism-transport-stats");
  const writeIntervalMs = options.writeIntervalMs ?? 5_000;
  const logger          = options.logger;

  // Unique per worker — pid alone collides when forks share a directory.
  const workerId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const statsFile = `${workerId}.json`;
  const statsTmp  = `${workerId}.tmp`;

  const providers = new Map<string, () => TransportStats>();
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let flushErrorLogged = false;

  async function flush() {
    const chains: Record<string, TransportStats> = {};
    for (const [chain, fn] of providers) chains[chain] = fn();

    const payload = JSON.stringify({ ts: Date.now(), chains });
    // 0o700 / 0o600 — stats encode operational signal (request rates, evictions)
    // that shouldn't leak to other local users on a shared host, and a writable
    // dir would let any local process poison the aggregator.
    await mkdir(statsDir, { recursive: true, mode: 0o700 });

    // Write-then-rename for atomic publish — readers never see a partial file.
    const tmp = join(statsDir, statsTmp);
    const dst = join(statsDir, statsFile);
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, dst);
  }

  function reportFlushError(err: unknown) {
    if (flushErrorLogged) return;
    flushErrorLogged = true;
    logger?.error(`[StatsSync] flush failed for ${statsDir} (further errors suppressed)`, err);
  }

  return {
    /** Register a chain's stats accessor. Call before `start()`. */
    registerProvider(chain: string, getStats: () => TransportStats) {
      providers.set(chain, getStats);
    },

    /** Begin periodic flushing. Idempotent. */
    start() {
      if (intervalHandle) return;
      intervalHandle = setInterval(() => flush().catch(reportFlushError), writeIntervalMs);
      // Don't keep the event loop alive just to flush stats.
      if (intervalHandle.unref) intervalHandle.unref();
      flush().catch(reportFlushError);
    },

    /** Stop flushing and remove this worker's stats file. */
    dispose() {
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
      try { unlinkSync(join(statsDir, statsFile)); } catch {}
    },
  };
}

interface StatsFile {
  ts: number;
  chains: Record<string, TransportStats>;
}

/**
 * Reject anything that doesn't structurally match {@link StatsFile}. The stats
 * directory lives in `tmpdir()` by default and is world-readable on most
 * systems, so files there are untrusted input.
 */
function isValidStatsFile(data: unknown): data is StatsFile {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.ts !== "number") return false;
  if (!obj.chains || typeof obj.chains !== "object") return false;
  for (const stats of Object.values(obj.chains as Record<string, unknown>)) {
    const s = stats as { tierCounters?: { hyperSync?: unknown; public?: unknown; paid?: unknown; queue?: unknown } };
    const tc = s?.tierCounters;
    if (!tc || !tc.hyperSync || !tc.public || !tc.paid || !tc.queue) return false;
  }
  return true;
}

/**
 * Read stats from every active worker and return one snapshot per chain —
 * the worker with the highest total request count for that chain wins
 * (likely the one currently handling its traffic).
 *
 * Files older than `staleMs` are deleted on read; they almost always
 * represent a worker that crashed or shut down without disposing.
 *
 * @returns Empty array when the stats directory cannot be read.
 */
export async function readAllWorkerStats(options: {
  statsDir?: string;
  staleMs?: number;
} = {}): Promise<TransportStats[]> {
  const statsDir = options.statsDir ?? join(tmpdir(), "prism-transport-stats");
  const staleMs  = options.staleMs  ?? 30_000;

  await mkdir(statsDir, { recursive: true }).catch(() => {});

  const now = Date.now();
  const chainMap = new Map<string, { stats: TransportStats; total: number }>();

  let files: string[];
  try {
    files = (await readdir(statsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  for (const file of files) {
    try {
      const raw = await readFile(join(statsDir, file), "utf-8");
      const data: unknown = JSON.parse(raw);
      if (!isValidStatsFile(data)) continue;

      if (now - data.ts > staleMs) {
        unlink(join(statsDir, file)).catch(() => {});
        continue;
      }

      for (const [chain, stats] of Object.entries(data.chains)) {
        const tc = stats.tierCounters;
        const total =
          tc.hyperSync.requests + tc.public.requests + tc.paid.requests + tc.queue.requests;

        const existing = chainMap.get(chain);
        if (!existing || total > existing.total) {
          chainMap.set(chain, { stats, total });
        }
      }
    } catch {
      // Corrupt or torn write — skip this file and keep going.
    }
  }

  return Array.from(chainMap.values()).map((v) => v.stats);
}
