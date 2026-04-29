import type { InternalLogger } from "./logger";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Consecutive failures before the circuit opens. @defaultValue 5 */
  failureThreshold?: number;
  /** Cooldown in ms before a half-open probe is allowed. @defaultValue 30_000 */
  cooldownMs?: number;
}

/**
 * Per-chain circuit breaker for RPC traffic.
 *
 * After `failureThreshold` consecutive failures the circuit opens and rejects
 * requests immediately for `cooldownMs`, preventing queue buildup and
 * resource exhaustion during sustained outages. After the cooldown a single
 * probe is allowed; success closes the circuit, failure reopens it.
 *
 * ```text
 * CLOSED ──N failures──▶ OPEN ──cooldown──▶ HALF_OPEN ──success──▶ CLOSED
 *                          ▲                    │
 *                          └──── failure ───────┘
 * ```
 *
 * @param chainName - Used in log lines for diagnostic readability.
 * @param logger - Sink for state transitions.
 * @param options - See {@link CircuitBreakerOptions}.
 */
export function createCircuitBreaker(
  chainName: string,
  logger: InternalLogger,
  options: CircuitBreakerOptions = {},
) {
  const failureThreshold = options.failureThreshold ?? 5;
  const cooldownMs       = options.cooldownMs       ?? 30_000;

  let state: CircuitState = "CLOSED";
  let consecutiveFailures = 0;
  let lastFailureTime = 0;
  let probeInFlight = false;

  return {
    /** Current breaker state. */
    get state() {
      return state;
    },

    /**
     * Whether a request may proceed. Transitions OPEN → HALF_OPEN once the
     * cooldown has elapsed and grants the slot to a single probe.
     */
    canRequest(): boolean {
      if (state === "CLOSED") return true;

      if (state === "OPEN") {
        if (Date.now() - lastFailureTime >= cooldownMs) {
          state = "HALF_OPEN";
          probeInFlight = true;
          logger.info(`[CircuitBreaker - ${chainName}] Half-open, allowing probe request`);
          return true;
        }
        return false;
      }

      // HALF_OPEN: at most one probe at a time.
      if (probeInFlight) return false;
      probeInFlight = true;
      return true;
    },

    /** Record a successful request — closes the circuit. */
    onSuccess() {
      if (state !== "CLOSED") {
        logger.success(`[CircuitBreaker - ${chainName}] Probe succeeded, circuit closed`);
      }
      consecutiveFailures = 0;
      state = "CLOSED";
      probeInFlight = false;
    },

    /**
     * Record a failed request. Opens the circuit when the threshold is
     * reached, or reopens it when a half-open probe fails.
     */
    onFailure() {
      consecutiveFailures++;
      lastFailureTime = Date.now();
      probeInFlight = false;

      if (state === "HALF_OPEN") {
        state = "OPEN";
        logger.warn(
          `[CircuitBreaker - ${chainName}] Probe failed, reopening circuit (cooldown: ${cooldownMs / 1000}s)`,
        );
        return;
      }

      if (consecutiveFailures >= failureThreshold) {
        state = "OPEN";
        logger.warn(
          `[CircuitBreaker - ${chainName}] Circuit OPEN after ${consecutiveFailures} consecutive failures (cooldown: ${cooldownMs / 1000}s)`,
        );
      }
    },

    /** Snapshot the breaker state. */
    getStats() {
      return {
        state,
        consecutiveFailures,
        lastFailureTime,
        cooldownMs,
      };
    },
  };
}
