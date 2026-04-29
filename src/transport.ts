import { custom, RpcRequestError } from "viem";
import { createRoundRobinPool, type RpcPool } from "./roundRobin";
import { createFallbackQueue } from "./fallbackQueue";
import { createCircuitBreaker } from "./circuitBreaker";
import { createTransportRegistry, type TransportRegistry } from "./registry";
import { createLogger } from "./logger";
import {
  CONTRACT_REVERT_CODE,
  hostOf,
  originOf,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./internal/jsonRpc";
import type {
  PrismRequestEvent,
  PrismTransportOptions,
  TierCounter,
  TransportStats,
} from "./types";

const newTierCounter = (): TierCounter => ({ requests: 0, successes: 0, failures: 0 });

/**
 * Create a viem-compatible transport that fans out across HyperSync, public,
 * and paid RPC tiers, with a bounded fallback queue and a per-chain circuit
 * breaker.
 *
 * Routing by method:
 *
 * | Method                                       | Order                                       |
 * | -------------------------------------------- | ------------------------------------------- |
 * | `eth_getLogs`                                | HyperSync → paid → fallback queue           |
 * | `eth_getBlockByNumber` (hex block, validated)| HyperSync → public → paid → queue           |
 * | `eth_getBlockByNumber` (`latest`/`safe`/...) | public → paid → queue                       |
 * | everything else                              | public → HyperSync → paid → queue           |
 *
 * Tag-based block requests skip HyperSync because its chain view lags
 * real-time. Hex-block requests are validated against the response — a stale
 * or null block is treated as a tier failure so the offending URL can be
 * evicted from the pool.
 *
 * @param options - Transport configuration. See {@link PrismTransportOptions}.
 * @param registry - Optional shared registry for multi-chain stats aggregation.
 *   When omitted, a new registry is created for this transport alone.
 *
 * @returns The viem `transport`, a `getStats` snapshot accessor, and the
 *   `registry` instance (useful for wiring additional chains into the same
 *   stats view).
 *
 * @example Single chain
 * ```ts
 * import { createPublicClient } from "viem";
 * import { polygon } from "viem/chains";
 * import { createPrismTransport } from "prism-transport";
 *
 * const { transport } = createPrismTransport({
 *   chainName: "polygon",
 *   publicUrls: ["https://polygon-bor-rpc.publicnode.com"],
 *   hyperSyncUrls: ["https://polygon.hypersync.xyz"],
 *   paidUrls: ["https://polygon-mainnet.g.alchemy.com/v2/KEY"],
 * });
 *
 * const client = createPublicClient({ chain: polygon, transport });
 * ```
 *
 * @example Sharing a registry across chains
 * ```ts
 * const { registry } = createPrismTransport({ chainName: "polygon", ... });
 * createPrismTransport({ chainName: "arbitrum", ... }, registry);
 * registry.getAllStats(); // [{ chain: "polygon", ... }, { chain: "arbitrum", ... }]
 * ```
 */
export function createPrismTransport(
  options: PrismTransportOptions,
  registry?: TransportRegistry,
) {
  const {
    chainName,
    publicUrls,
    paidUrls = [],
    hyperSyncUrls = [],
    verbose = false,
    disableHyperSyncBlockFetch = false,
  } = options;

  const logger = options.logger ?? createLogger(verbose);
  const transportRegistry = registry ?? createTransportRegistry(logger);

  const poolOpts = {
    chainName,
    failureThreshold: options.pool?.failureThreshold,
    cooldownMs: options.pool?.cooldownMs,
  };
  const publicPool = createRoundRobinPool(publicUrls, logger, poolOpts);
  const hyperSyncPool = hyperSyncUrls.length > 0
    ? createRoundRobinPool(hyperSyncUrls, logger, poolOpts)
    : null;

  const fallbackQueue = createFallbackQueue(paidUrls, chainName, logger, options.fallbackQueue);
  const circuitBreaker = createCircuitBreaker(chainName, logger, options.circuitBreaker);

  const defaultTimeout = options.timeouts?.default ?? 10_000;
  const ethGetLogsTimeout = options.timeouts?.ethGetLogs ?? 15_000;
  const ethGetLogsFallbackTimeout = options.timeouts?.ethGetLogsFallback ?? 10_000;
  const ethGetLogsFallbackTotalTimeout = options.timeouts?.ethGetLogsFallbackTotal ?? 15_000;
  const maxResponseBytes = options.maxResponseBytes ?? 50 * 1024 * 1024;

  const tierCounters = {
    hyperSync: newTierCounter(),
    public: newTierCounter(),
    paid: newTierCounter(),
    queue: newTierCounter(),
  };

  type MethodCounter = { total: number; successes: number; failures: number };

  const methodCounters = new Map<string, MethodCounter>();
  // Cap cardinality so a malicious or buggy caller can't grow the map without
  // bound by sending arbitrary method names. Standard EVM RPC has ~70 methods.
  const MAX_METHOD_COUNTERS = 256;

  const trackMethod = (method: string, success: boolean) => {
    let c = methodCounters.get(method);
    if (!c) {
      if (methodCounters.size >= MAX_METHOD_COUNTERS) return;
      c = { total: 0, successes: 0, failures: 0 };
      methodCounters.set(method, c);
    }
    c.total++;
    if (success) c.successes++;
    else c.failures++;
  };

  // Per-instance JSON-RPC id; uniqueness is scoped to this transport.
  let rpcIdCounter = 0;

  /**
   * POST a JSON-RPC body to a single URL. Throws on transport, HTTP, or RPC
   * errors. Contract reverts are surfaced as a typed {@link RpcRequestError}
   * so callers can short-circuit retry logic.
   */
  const fetchRpc = async <R>(
    url: string,
    body: JsonRpcRequest,
    timeoutMs = defaultTimeout,
  ): Promise<R> => {
    const host = hostOf(url);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((e: Error) => {
      logger.info(`Failed on ${host} for ${body.method} (${e.message})`);
      throw e;
    });

    if (!response.ok) {
      // Drain the body so undici can return the keep-alive socket to the pool.
      await response.body?.cancel().catch(() => { });
      logger.info(`Failed on ${host} for ${body.method} (HTTP ${response.status})`);
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maxResponseBytes) {
      await response.body?.cancel().catch(() => { });
      logger.info(`Failed on ${host} for ${body.method} (response too large: ${declaredSize}B > ${maxResponseBytes}B)`);
      throw new Error(`Response too large: ${declaredSize} bytes exceeds ${maxResponseBytes}`);
    }

    // Stream the body and abort once the cap is exceeded. Header-based check
    // alone is bypassable (chunked encoding, missing/garbage Content-Length).
    const reader = response.body?.getReader();
    if (!reader) {
      logger.info(`Failed on ${host} for ${body.method} (response body not readable)`);
      throw new Error("Response body is not readable");
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxResponseBytes) {
        await reader.cancel().catch(() => { });
        logger.info(`Failed on ${host} for ${body.method} (response exceeded ${maxResponseBytes}B)`);
        throw new Error(`Response too large: exceeded ${maxResponseBytes} bytes`);
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    const json = JSON.parse(new TextDecoder().decode(buf)) as JsonRpcResponse<R>;

    if (json.error) {
      // Contract reverts are deterministic — surface as a typed error so the
      // circuit breaker and fallback tiers can skip them.
      const isRevert =
        json.error.code === CONTRACT_REVERT_CODE ||
        (json.error.message?.toLowerCase().includes("execution reverted") ?? false);
      if (isRevert) {
        // Use the URL's origin so any API key embedded in the path/query/userinfo
        // is stripped before the error crosses into caller logs.
        throw new RpcRequestError({
          body: body as unknown as Record<string, unknown>,
          error: json.error,
          url: originOf(url),
        });
      }

      logger.info(`Failed on ${host} for ${body.method} (${json.error.message})`);
      throw new Error(`RPC Error: ${json.error.message}`);
    }

    // Some providers return null for an empty `eth_getLogs` result. Reject
    // rather than silently coercing to [] — masking it would hide real bugs.
    if (body.method === "eth_getLogs" && !Array.isArray(json.result)) {
      logger.info(`Failed on ${host} for ${body.method} (Null Response)`);
      throw new Error(`RPC Error: Invalid empty eth_getLogs response (Got: ${json.result})`);
    }

    logger.info(`Success on ${host} for ${body.method}`);
    return json.result as R;
  };

  /** Try each URL in order; returns the first success, or `undefined` if all fail. */
  const tryUrls = async <R>(
    urls: readonly string[],
    body: JsonRpcRequest,
    timeoutMs?: number,
  ): Promise<R | undefined> => {
    const isCritical = body.method === "eth_getLogs" || body.method === "eth_getBlockByNumber";
    for (const url of urls) {
      try {
        return await fetchRpc<R>(url, body, timeoutMs);
      } catch (error) {
        if (error instanceof RpcRequestError) throw error;
        const msg = `tryUrls failed on ${hostOf(url)} for ${body.method}: ${(error as Error).message}`;
        if (isCritical) logger.warn(msg);
        else logger.info(msg);
      }
    }
    return undefined;
  };

  /** Fetch from a pooled URL and report the outcome back to the pool. */
  const fetchFromPool = async <R>(
    pool: RpcPool,
    body: JsonRpcRequest,
    timeoutMs?: number,
  ): Promise<R> => {
    const url = pool.next();
    try {
      const result = await fetchRpc<R>(url, body, timeoutMs);
      pool.success(url);
      return result;
    } catch (error) {
      pool.failure(url);
      throw error;
    }
  };

  /** Push to the fallback queue as a last resort. */
  const queueFallback = <R>(
    body: JsonRpcRequest,
    perCallTimeoutMs?: number,
    totalTimeoutMs?: number,
  ): Promise<R> => {
    logger.warn(`[Transport - ${chainName}] All RPCs failed for ${body.method}, queuing...`);
    return fallbackQueue.push<R>(
      (url) => fetchRpc<R>(url, body, perCallTimeoutMs),
      totalTimeoutMs,
    );
  };

  /**
   * Run `attempt`, increment the right counter, and re-throw revert errors.
   * Any other failure resolves to `undefined` so the caller can fall through
   * to the next tier.
   */
  const tryTier = async <R>(
    counter: TierCounter,
    attempt: () => Promise<R>,
  ): Promise<R | undefined> => {
    counter.requests++;
    try {
      const result = await attempt();
      counter.successes++;
      return result;
    } catch (e) {
      counter.failures++;
      if (e instanceof RpcRequestError) throw e;
      return undefined;
    }
  };

  const allTiersFailed = (method: string, cause?: unknown): Error =>
    new Error(
      `[Transport - ${chainName}] All RPCs failed for ${method}, no fallback available.`,
      cause !== undefined ? { cause } : undefined,
    );

  /**
   * Run the fallback queue inline so its rejection reason (e.g. "Queue full")
   * survives as the `cause` of the eventual top-level error — the queue tier
   * is the only one whose failure mode carries actionable signal for callers.
   */
  const runQueueTier = async <R>(
    body: JsonRpcRequest,
    perCallTimeoutMs?: number,
    totalTimeoutMs?: number,
  ): Promise<R> => {
    tierCounters.queue.requests++;
    try {
      const result = await queueFallback<R>(body, perCallTimeoutMs, totalTimeoutMs);
      tierCounters.queue.successes++;
      return result;
    } catch (e) {
      tierCounters.queue.failures++;
      if (e instanceof RpcRequestError) throw e;
      throw allTiersFailed(body.method, e);
    }
  };

  async function handleGetLogs<R>(body: JsonRpcRequest): Promise<R> {
    if (hyperSyncPool) {
      const result = await tryTier(tierCounters.hyperSync, () => fetchFromPool<R>(hyperSyncPool, body));
      if (result !== undefined) return result;
    }

    tierCounters.paid.requests++;
    const paidResult = await tryUrls<R>(paidUrls, body, ethGetLogsTimeout);
    if (paidResult !== undefined) {
      tierCounters.paid.successes++;
      return paidResult;
    }
    tierCounters.paid.failures++;

    if (paidUrls.length === 0) throw allTiersFailed(body.method);
    return runQueueTier<R>(body, ethGetLogsFallbackTimeout, ethGetLogsFallbackTotalTimeout);
  }

  /**
   * Probe HyperSync for a hex-block request, then fall through. Validates the
   * returned block number against the request — a HyperSync URL that lags
   * behind the chain head will be evicted via {@link RpcPool.failure}, since
   * `fetchFromPool`'s automatic success report would otherwise mask it.
   */
  async function handleHexBlock<R extends { number?: string } | null>(
    body: JsonRpcRequest,
    blockArg: string,
  ): Promise<R> {
    if (hyperSyncPool) {
      tierCounters.hyperSync.requests++;
      const url = hyperSyncPool.next();
      try {
        const result = await fetchRpc<R>(url, body);
        if (result?.number && BigInt(result.number) === BigInt(blockArg)) {
          hyperSyncPool.success(url);
          tierCounters.hyperSync.successes++;
          return result;
        }
        hyperSyncPool.failure(url);
        tierCounters.hyperSync.failures++;
      } catch (e) {
        hyperSyncPool.failure(url);
        tierCounters.hyperSync.failures++;
        if (e instanceof RpcRequestError) throw e;
      }
    }
    return handleDefault<R>(body, /* skipHyperSync */ true);
  }

  async function handleDefault<R>(body: JsonRpcRequest, skipHyperSync = false): Promise<R> {
    const fromPublic = await tryTier(tierCounters.public, () => fetchFromPool<R>(publicPool, body));
    if (fromPublic !== undefined) return fromPublic;

    if (hyperSyncPool && !skipHyperSync && body.method !== "eth_getBlockByNumber") {
      const fromHs = await tryTier(tierCounters.hyperSync, () => fetchFromPool<R>(hyperSyncPool, body));
      if (fromHs !== undefined) return fromHs;
    }

    tierCounters.paid.requests++;
    const paidResult = await tryUrls<R>(paidUrls, body);
    if (paidResult !== undefined) {
      tierCounters.paid.successes++;
      return paidResult;
    }
    tierCounters.paid.failures++;

    if (paidUrls.length === 0) throw allTiersFailed(body.method);
    return runQueueTier<R>(body);
  }

  function routeRequest(body: JsonRpcRequest): Promise<unknown> {
    if (body.method === "eth_getLogs") return handleGetLogs(body);

    if (body.method === "eth_getBlockByNumber" && hyperSyncPool && !disableHyperSyncBlockFetch) {
      const blockArg = (body.params as unknown[] | undefined)?.[0];

      if (typeof blockArg === "string" && /^0x[0-9a-fA-F]+$/.test(blockArg)) {
        return handleHexBlock(body, blockArg);
      }
    }
    return handleDefault(body);
  }

  /**
   * Snapshot the cumulative stats for this transport. Counters are
   * deep-cloned and URLs are redacted to hostnames so the result is safe to
   * expose on a public `/metrics` endpoint.
   */
  const getStats = (): TransportStats => ({
    chain: chainName,
    circuitBreaker: circuitBreaker.getStats(),
    fallbackQueue: fallbackQueue.getStats(),
    publicPool: publicPool.getStats(),
    hyperSyncPool: hyperSyncPool?.getStats() ?? null,
    paidUrls: paidUrls.map(hostOf),
    tierCounters: {
      hyperSync: { ...tierCounters.hyperSync },
      public: { ...tierCounters.public },
      paid: { ...tierCounters.paid },
      queue: { ...tierCounters.queue },
    },
    methodCounters: Object.fromEntries(
      Array.from(methodCounters, ([k, v]) => [k, { ...v }]),
    ),
  });

  transportRegistry.register(chainName, getStats);

  const emitRequestEvent = (event: PrismRequestEvent) => {
    if (!options.onRequest) return;
    try {
      options.onRequest(event);
    } catch (hookError) {
      // Hook failures must never break the transport. Surface and move on.
      logger.error(`[Transport - ${chainName}] onRequest hook threw`, hookError);
    }
  };

  const transport = custom({
    async request({ method, params }) {
      const startedAt = performance.now();
      const body: JsonRpcRequest = { jsonrpc: "2.0", id: ++rpcIdCounter, method, params };

      if (!circuitBreaker.canRequest()) {
        trackMethod(method, false);
        const error = new Error(`[Transport - ${chainName}] Circuit open, rejecting ${method}`);
        emitRequestEvent({ chain: chainName, method, ok: false, durationMs: performance.now() - startedAt, error });
        throw error;
      }

      try {
        const result = await routeRequest(body);
        circuitBreaker.onSuccess();
        trackMethod(method, true);
        emitRequestEvent({ chain: chainName, method, ok: true, durationMs: performance.now() - startedAt });
        return result;
      } catch (error) {
        // A contract revert proves the RPC infra is healthy; treat it as success
        // for the breaker so a HALF_OPEN probe can release its slot.
        if (error instanceof RpcRequestError) circuitBreaker.onSuccess();
        else circuitBreaker.onFailure();
        trackMethod(method, false);
        emitRequestEvent({ chain: chainName, method, ok: false, durationMs: performance.now() - startedAt, error });
        throw error;
      }
    },
  });

  /**
   * Release this transport's references for graceful shutdown — unregister
   * from the shared registry and drop any pending fallback-queue requests.
   * In-flight fetches finish naturally; new calls on `transport` after
   * `dispose()` will still execute but no longer surface in registry stats.
   */
  const dispose = () => {
    transportRegistry.unregister(chainName);
    fallbackQueue.clear();
  };

  return {
    /** viem-compatible custom transport. */
    transport,
    /** Snapshot of cumulative stats for this chain. */
    getStats,
    /** Transport registry — shared across chains when one is passed in. */
    registry: transportRegistry,
    /** Release references; safe to call multiple times. */
    dispose,
  };
}
