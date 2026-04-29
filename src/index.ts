/**
 * Tiered EVM RPC transport with circuit breaker, round-robin load balancing,
 * and a bounded fallback queue. Built on viem's `custom()` transport.
 *
 * @packageDocumentation
 */

export { createPrismTransport } from "./transport";

// Building blocks — exported for advanced use, but most callers only need
// `createPrismTransport`.
export { createRoundRobinPool } from "./roundRobin";
export { createCircuitBreaker } from "./circuitBreaker";
export { createFallbackQueue } from "./fallbackQueue";
export { createTransportRegistry } from "./registry";

// Optional plugin for multi-worker stats aggregation.
export { createStatsSync, readAllWorkerStats } from "./statsSync";

export type {
  PrismTransportOptions,
  PrismRequestEvent,
  TransportStats,
  CircuitBreakerStats,
  FallbackQueueStats,
  TierCounter,
  MethodCounter,
} from "./types";
export type { RpcPool, RpcPoolStats, RoundRobinOptions } from "./roundRobin";
export type { CircuitBreakerOptions, CircuitState } from "./circuitBreaker";
export type { FallbackQueueOptions, RequestFn } from "./fallbackQueue";
export type { TransportRegistry } from "./registry";
export type { StatsSyncOptions } from "./statsSync";
export type { InternalLogger } from "./logger";
