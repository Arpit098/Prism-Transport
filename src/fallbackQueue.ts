import PQueue from "p-queue";
import { hostOf } from "./internal/jsonRpc";
import type { InternalLogger } from "./logger";

export interface FallbackQueueOptions {
  /** Maximum requests in flight at once. @defaultValue 10 */
  concurrency?: number;
  /** Hard cap on queued + in-flight requests; pushes beyond this reject. @defaultValue 50 */
  maxSize?: number;
  /** Default total timeout per queued request, in ms. @defaultValue 15_000 */
  totalTimeoutMs?: number;
}

/**
 * Function executed for each queued request.
 *
 * @param url - The paid RPC URL to attempt.
 * @returns The RPC result on success.
 */
export type RequestFn<R> = (url: string) => Promise<R>;

/**
 * Last-resort retry queue for failed RPC requests.
 *
 * Each queued attempt does a SINGLE PASS across the paid URLs — first success
 * wins, no exponential backoff — wrapped in a hard total timeout so a stuck
 * provider can't pin the queue.
 *
 * - **Concurrency** is capped to avoid hammering paid providers.
 * - **Size** is capped to prevent OOM during sustained outages; pushes beyond
 *   the cap reject synchronously, surfacing backpressure to callers.
 *
 * @param paidUrls - URLs to try, in order. May be empty (the queue still
 *   accepts pushes, but they will fail fast).
 * @param chainName - Used in log lines for diagnostic readability.
 */
export function createFallbackQueue(
  paidUrls: readonly string[],
  chainName: string,
  logger: InternalLogger,
  options: FallbackQueueOptions = {},
) {
  const concurrency           = options.concurrency    ?? 10;
  const maxSize               = options.maxSize        ?? 50;
  const defaultTotalTimeoutMs = options.totalTimeoutMs ?? 15_000;

  if (paidUrls.length === 0) {
    logger.warn(`[Fallback - ${chainName}] No paid RPC URLs provided.`);
  }

  const queue = new PQueue({ concurrency });

  let totalQueued = 0;
  let totalResolved = 0;
  let totalRejected = 0;
  let totalTimedOut = 0;
  let totalFailed = 0;

  /** Try each paid URL in order; first success wins, no retries. */
  const trySinglePass = async <R>(requestFn: RequestFn<R>): Promise<R> => {
    for (const url of paidUrls) {
      try {
        return await requestFn(url);
      } catch (error) {
        logger.warn(`[Fallback - ${chainName}] ${hostOf(url)}: ${(error as Error).message}`);
      }
    }
    throw new Error(`[Fallback - ${chainName}] All paid RPCs failed (single pass).`);
  };

  /** Race `work` against a hard timeout, always clearing the timer. */
  const withTotalTimeout = <R>(work: Promise<R>, budgetMs: number): Promise<R> => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`[Fallback - ${chainName}] Total timeout (${budgetMs}ms) exceeded`)),
        budgetMs,
      );
    });
    return Promise.race([work, timeout]).finally(() => {
      if (handle) clearTimeout(handle);
    });
  };

  return {
    /**
     * Enqueue a request. Rejects synchronously when the queue is full.
     *
     * @param requestFn - Called once per paid URL until one succeeds.
     * @param totalTimeoutMs - Override for this request only.
     */
    push: async <R>(requestFn: RequestFn<R>, totalTimeoutMs?: number): Promise<R> => {
      const currentLoad = queue.size + queue.pending;
      if (currentLoad >= maxSize) {
        totalRejected++;
        throw new Error(`[Fallback - ${chainName}] Queue full (${currentLoad}/${maxSize}), rejecting request.`);
      }

      totalQueued++;
      logger.warn(`[Fallback - ${chainName}] Queued (size: ${queue.size}, pending: ${queue.pending})`);

      const budget = totalTimeoutMs ?? defaultTotalTimeoutMs;
      return queue.add(async () => {
        try {
          const result = await withTotalTimeout(trySinglePass(requestFn), budget);
          totalResolved++;
          logger.success(`[Fallback - ${chainName}] Resolved queued request.`);
          return result;
        } catch (error) {
          if ((error as Error)?.message?.includes("Total timeout")) totalTimedOut++;
          else totalFailed++;
          logger.error(`[Fallback - ${chainName}] Failed to resolve queued request.`, error);
          throw error;
        }
      }) as Promise<R>;
    },

    /**
     * Drop every pending request from the queue. In-flight requests continue
     * to completion since their fetches are already on the network.
     */
    clear: () => queue.clear(),

    /** Snapshot queue health and counters. */
    getStats: () => ({
      size: queue.size,
      pending: queue.pending,
      maxSize,
      totalQueued,
      totalResolved,
      totalRejected,
      totalTimedOut,
      totalFailed,
    }),
  };
}
