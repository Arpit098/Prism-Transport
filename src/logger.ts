/**
 * Minimal logging surface used by the transport. Implement this interface to
 * forward logs to Pino, Winston, or any other sink — see
 * {@link PrismTransportOptions.logger}.
 */
export interface InternalLogger {
  /** Routine activity. Suppressed by the default logger when `verbose` is false. */
  info(msg: string): void;
  /** Recoverable problems that warrant attention. */
  warn(msg: string): void;
  /** Errors. The optional `err` carries the original cause for stack traces. */
  error(msg: string, err?: unknown): void;
  /** Recovery from a degraded state. Suppressed by the default logger when `verbose` is false. */
  success(msg: string): void;
}

/**
 * Default `console`-backed logger.
 *
 * @param verbose - When false, only `warn` and `error` reach the console;
 *   `info` and `success` are suppressed. When true, all four levels are
 *   emitted.
 */
export function createLogger(verbose: boolean): InternalLogger {
  return {
    info(msg) {
      if (verbose) console.log(`[prism-transport] [INFO] ${msg}`);
    },
    warn(msg) {
      console.warn(`[prism-transport] [WARN] ${msg}`);
    },
    error(msg, err) {
      console.error(`[prism-transport] [ERROR] ${msg}`);
      if (err) console.error(err instanceof Error ? err.stack ?? err.message : err);
    },
    success(msg) {
      if (verbose) console.log(`[prism-transport] [OK] ${msg}`);
    },
  };
}
