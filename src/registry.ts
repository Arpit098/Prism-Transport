import type { InternalLogger } from "./logger";
import type { TransportStats } from "./types";

/**
 * Registry of stats accessors keyed by chain.
 *
 * Each registry is an isolated container — pass the same instance to multiple
 * `createPrismTransport` calls to aggregate stats across chains, or call
 * `createTransportRegistry()` again for a fresh, separate view.
 *
 * @example
 * ```ts
 * const registry = createTransportRegistry();
 * createPrismTransport({ chainName: "polygon", ... }, registry);
 * createPrismTransport({ chainName: "arbitrum", ... }, registry);
 * registry.getAllStats(); // both chains
 * ```
 */
export function createTransportRegistry(logger?: InternalLogger) {
  const registry = new Map<string, () => TransportStats>();

  return {
    /**
     * Register a chain's stats accessor. Re-registering the same chain logs a
     * warning — the new accessor replaces the old one and the previous
     * transport's stats become unreachable.
     */
    register(chain: string, getStats: () => TransportStats) {
      if (registry.has(chain)) {
        logger?.warn(`[Registry] Overwriting existing registration for "${chain}"`);
      }
      registry.set(chain, getStats);
    },
    /** Remove a chain's stats accessor. Returns true if a registration was removed. */
    unregister(chain: string): boolean {
      return registry.delete(chain);
    },
    /** Snapshot stats for every registered chain. */
    getAllStats(): TransportStats[] {
      return Array.from(registry.values()).map((get) => get());
    },
  };
}

export type TransportRegistry = ReturnType<typeof createTransportRegistry>;
