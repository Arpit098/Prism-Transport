import { hostOf } from "./internal/jsonRpc";
import type { InternalLogger } from "./logger";

export interface RoundRobinOptions {
  /** Display name (typically the chain) used in log lines. */
  chainName?: string;
  /** Consecutive failures before evicting a URL. @defaultValue 5 */
  failureThreshold?: number;
  /** Eviction cooldown in ms. @defaultValue 300_000 (5 minutes) */
  cooldownMs?: number;
  /**
   * Starting cursor offset. When omitted the pool picks a random index, which
   * spreads cold-start load across URLs when many transports boot at once
   * (e.g. across worker threads). Set explicitly for deterministic tests.
   */
  startIndex?: number;
}

export interface RpcPoolStats {
  urls: readonly string[];
  evicted: string[];
  /** Consecutive failure count per URL (resets on success or eviction). */
  failures: Record<string, number>;
  /** Cumulative request count per URL since startup. */
  totalRequests: Record<string, number>;
  /** Cumulative success count per URL since startup. */
  totalSuccesses: Record<string, number>;
  /** Cumulative failure count per URL since startup. */
  totalFailures: Record<string, number>;
}

export interface RpcPool {
  /** Take the next healthy URL in rotation. */
  next: () => string;
  /** Report a successful request — clears the failure streak. */
  success: (url: string) => void;
  /** Report a failed request — may evict the URL. */
  failure: (url: string) => void;
  /**
   * Forget all evictions and consecutive-failure streaks, restoring every URL
   * to rotation. Cumulative counters are preserved. Useful for "warm-up" after
   * a known network event (e.g. recovering from a regional outage).
   */
  reset: () => void;
  /** Snapshot of pool health and counters. */
  getStats: () => RpcPoolStats;
}

/**
 * Round-robin RPC pool with auto-eviction and self-healing.
 *
 * After `failureThreshold` consecutive failures on a URL, the pool removes it
 * from rotation for `cooldownMs`. Healthy URLs keep serving traffic; once the
 * cooldown elapses the URL is reinstated on its next turn. Callers must
 * report outcomes via `success()` / `failure()` so the pool can track health.
 *
 * @throws If `urls` is empty.
 */
export function createRoundRobinPool(
  urls: readonly string[],
  logger: InternalLogger,
  options: RoundRobinOptions = {},
): RpcPool {
  if (urls.length === 0) {
    throw new Error("No RPC URLs provided for round-robin pool");
  }

  const failureThreshold = options.failureThreshold ?? 5;
  const cooldownMs       = options.cooldownMs       ?? 5 * 60_000;
  const tag              = options.chainName ? ` - ${options.chainName}` : "";

  let cursor =
    options.startIndex !== undefined
      ? ((options.startIndex % urls.length) + urls.length) % urls.length
      : Math.floor(Math.random() * urls.length);
  const failures = new Map<string, number>();
  const evictedUntil = new Map<string, number>();

  const totalRequests  = new Map<string, number>();
  const totalSuccesses = new Map<string, number>();
  const totalFailures  = new Map<string, number>();

  const bump = (m: Map<string, number>, url: string) => m.set(url, (m.get(url) ?? 0) + 1);

  return {
    next(): string {
      const now = Date.now();

      for (let i = 0; i < urls.length; i++) {
        const url = urls[cursor]!;
        cursor = (cursor + 1) % urls.length;

        const evictedAt = evictedUntil.get(url);
        const stillEvicted = evictedAt !== undefined && evictedAt > now;
        if (stillEvicted) continue;

        // Cooldown elapsed — bring the URL back into rotation.
        if (evictedAt !== undefined) {
          evictedUntil.delete(url);
          failures.delete(url);
          logger.info(`[RoundRobin${tag}] ${hostOf(url)} re-added to rotation`);
        }

        bump(totalRequests, url);
        return url;
      }

      // Every URL is in cooldown — return the next one anyway as a best-effort
      // probe. Callers will report the outcome and the pool will recover when
      // a real success comes in.
      const url = urls[cursor]!;
      cursor = (cursor + 1) % urls.length;
      bump(totalRequests, url);
      return url;
    },

    success(url) {
      failures.delete(url);
      bump(totalSuccesses, url);
    },

    failure(url) {
      const count = (failures.get(url) ?? 0) + 1;
      bump(totalFailures, url);

      if (count >= failureThreshold) {
        evictedUntil.set(url, Date.now() + cooldownMs);
        failures.delete(url);
        logger.warn(
          `[RoundRobin${tag}] Evicted ${hostOf(url)} for ${cooldownMs / 1000}s after ${failureThreshold} consecutive failures`,
        );
      } else {
        failures.set(url, count);
      }
    },

    reset() {
      const had = failures.size + evictedUntil.size;
      failures.clear();
      evictedUntil.clear();
      if (had > 0) logger.info(`[RoundRobin${tag}] Pool reset — ${urls.length} URL(s) restored`);
    },

    getStats() {
      // Stats are redacted to hostnames so callers can safely expose them
      // (e.g. on a /metrics endpoint) without leaking API keys baked into URLs.
      const now = Date.now();
      const evicted: string[] = [];
      for (const [url, until] of evictedUntil) {
        if (until > now) evicted.push(hostOf(url));
      }
      return {
        urls: urls.map(hostOf),
        evicted,
        failures:       redactByHost(failures),
        totalRequests:  redactByHost(totalRequests),
        totalSuccesses: redactByHost(totalSuccesses),
        totalFailures:  redactByHost(totalFailures),
      };
    },
  };
}

/** Aggregate per-URL counters by hostname; collisions sum. */
function redactByHost(m: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [url, val] of m) {
    const key = hostOf(url);
    out[key] = (out[key] ?? 0) + val;
  }
  return out;
}
