/**
 * Public types for prism-transport.
 */

import type { RpcPoolStats } from "./roundRobin";
import type { InternalLogger } from "./logger";
import type { CircuitState } from "./circuitBreaker";

/** Cumulative request counters for a single tier. */
export interface TierCounter {
  requests: number;
  successes: number;
  failures: number;
}

/** Cumulative request counters for a single RPC method. */
export interface MethodCounter {
  total: number;
  successes: number;
  failures: number;
}

/** Snapshot of circuit breaker state. */
export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownMs: number;
}

/**
 * Lifecycle event for a single RPC request, surfaced via
 * {@link PrismTransportOptions.onRequest}. Fires exactly once per top-level
 * call, after the transport has resolved or rejected it.
 */
export interface PrismRequestEvent {
  /** Chain this request was routed for — matches `chainName`. */
  chain: string;
  /** RPC method name (e.g. `eth_getLogs`). */
  method: string;
  /** Whether the request ultimately resolved. */
  ok: boolean;
  /** Wall-clock time from the moment the transport received the call until it resolved or rejected. */
  durationMs: number;
  /** The error, if `ok` is false. Contract reverts surface here as `RpcRequestError`. */
  error?: unknown;
}

/** Snapshot of fallback queue health. */
export interface FallbackQueueStats {
  size: number;
  pending: number;
  maxSize: number;
  totalQueued: number;
  totalResolved: number;
  totalRejected: number;
  totalTimedOut: number;
  totalFailed: number;
}

/** Aggregate stats for a single chain. Returned by `getStats()` and `registry.getAllStats()`. */
export interface TransportStats {
  chain: string;
  circuitBreaker: CircuitBreakerStats;
  fallbackQueue: FallbackQueueStats;
  publicPool: RpcPoolStats;
  hyperSyncPool: RpcPoolStats | null;
  paidUrls: readonly string[];
  tierCounters: {
    hyperSync: TierCounter;
    public: TierCounter;
    paid: TierCounter;
    queue: TierCounter;
  };
  methodCounters: Record<string, MethodCounter>;
}

/**
 * Configuration for {@link createPrismTransport}.
 *
 * Only `chainName` and `publicUrls` are required — every other field has a
 * sensible default suited to a typical indexer workload.
 */
export interface PrismTransportOptions {
  /** Display name for this chain (used in log lines and stats keys). */
  chainName: string;

  /** Public/free RPC URLs. At least one is required. */
  publicUrls: readonly string[];

  /** Paid/premium RPC URLs — used as a fallback tier and in the fallback queue. */
  paidUrls?: readonly string[];

  /** HyperSync-compatible URLs — preferred for `eth_getLogs` and validated hex blocks. */
  hyperSyncUrls?: readonly string[];

  /**
   * Log every RPC request/response to the console.
   *
   * When false (default), only `warn` and `error` reach the console; routine
   * activity is silenced. Ignored when `logger` is provided.
   *
   * @defaultValue false
   */
  verbose?: boolean;

  /**
   * Inject a custom logger (e.g. Pino, Winston). When provided, `verbose` is
   * ignored and all log calls are forwarded here. Pass a no-op logger to
   * silence the transport entirely.
   */
  logger?: InternalLogger;

  /**
   * Observability hook fired after every top-level request resolves or
   * rejects. Useful for wiring OpenTelemetry spans, structured-log emission,
   * or per-request metrics without having to read `getStats()` polling-style.
   *
   * Exceptions thrown from the hook are caught and ignored — never break
   * application flow.
   */
  onRequest?: (event: PrismRequestEvent) => void;

  /**
   * Skip HyperSync for `eth_getBlockByNumber` requests. Useful when HyperSync
   * lags real-time on a particular chain.
   *
   * @defaultValue false
   */
  disableHyperSyncBlockFetch?: boolean;

  /**
   * Reject responses whose body exceeds this size, in bytes. Guards against
   * a misbehaving provider OOMing the indexer with a multi-gigabyte response.
   *
   * @defaultValue 52_428_800 (50 MiB)
   */
  maxResponseBytes?: number;

  /** Circuit breaker configuration. */
  circuitBreaker?: {
    /** Consecutive failures before opening the circuit. @defaultValue 5 */
    failureThreshold?: number;
    /** Cooldown in ms before a half-open probe is allowed. @defaultValue 30_000 */
    cooldownMs?: number;
  };

  /** Round-robin pool configuration applied to both `publicUrls` and `hyperSyncUrls`. */
  pool?: {
    /** Consecutive failures before evicting a URL. @defaultValue 5 */
    failureThreshold?: number;
    /** Eviction cooldown in ms. @defaultValue 300_000 (5 minutes) */
    cooldownMs?: number;
  };

  /** Fallback queue configuration. */
  fallbackQueue?: {
    /** Maximum requests in flight at once. @defaultValue 10 */
    concurrency?: number;
    /** Hard cap on queued + in-flight requests; pushes beyond this reject. @defaultValue 50 */
    maxSize?: number;
    /** Default total timeout per queued request, in ms. @defaultValue 15_000 */
    totalTimeoutMs?: number;
  };

  /** Per-method timeout overrides, in ms. */
  timeouts?: {
    /** Default timeout for all RPC calls. @defaultValue 10_000 */
    default?: number;
    /** Timeout for `eth_getLogs` on the paid tier. @defaultValue 15_000 */
    ethGetLogs?: number;
    /** Per-call timeout for `eth_getLogs` in the fallback queue. @defaultValue 10_000 */
    ethGetLogsFallback?: number;
    /** Total timeout for `eth_getLogs` in the fallback queue. @defaultValue 15_000 */
    ethGetLogsFallbackTotal?: number;
  };
}
