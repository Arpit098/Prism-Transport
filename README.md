# prism-transport

[![npm](https://img.shields.io/npm/v/prism-transport.svg)](https://www.npmjs.com/package/prism-transport)
[![types](https://img.shields.io/npm/types/prism-transport.svg)](https://www.npmjs.com/package/prism-transport)
[![license](https://img.shields.io/npm/l/prism-transport.svg)](./LICENSE)

Method-aware EVM RPC transport for [viem](https://viem.sh) — splits requests across HyperSync, public, and paid tiers with a circuit breaker, round-robin load balancing, and a bounded fallback queue.

A `prism-transport` is a drop-in replacement for viem's `http()` transport, designed for production indexers, archive servers, and multi-chain backends where one URL is never enough.

## Features

- **Method-aware tiered routing** — `eth_getLogs`, `eth_getBlockByNumber`, and general RPC calls each take the path that suits them best
- **Round-robin pool** with auto-eviction and self-healing after configurable cooldowns
- **Circuit breaker** (CLOSED → OPEN → HALF_OPEN) to fail fast during sustained outages
- **Bounded fallback queue** with backpressure to prevent OOM during RPC outages
- **HyperSync integration** with response validation for stale/null block detection
- **Built-in observability** — per-tier and per-method counters, verbose logging mode, pluggable logger, per-request tracing hook
- **Optional cross-worker stats sync** for multi-threaded environments
- **Zero configuration required** — sensible defaults with full customization available

## Installation

```bash
npm install prism-transport viem
```

> `viem` is a peer dependency — install it alongside this package.

## Quick start

```typescript
import { createPrismTransport } from "prism-transport";
import { createPublicClient } from "viem";
import { polygon } from "viem/chains";

const { transport } = createPrismTransport({
  chainName: "polygon",
  publicUrls: [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.llamarpc.com",
  ],
  paidUrls: ["https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"],
  hyperSyncUrls: ["https://polygon.hypersync.xyz"],
  verbose: false, // set to true to see all RPC activity in the console
});

const client = createPublicClient({ chain: polygon, transport });
const blockNumber = await client.getBlockNumber();
```

## Routing logic

| Method | Tier order |
|---|---|
| `eth_getLogs` | HyperSync → Paid → Fallback queue |
| `eth_getBlockByNumber` (hex block) | HyperSync (validated) → Public → Paid → Queue |
| `eth_getBlockByNumber` (tag: `latest`/`safe`) | Public → Paid → Queue |
| Everything else | Public → HyperSync → Paid → Queue |

## Failure semantics

A call walks the tier ladder once. If everything fails, the call rejects and your framework retries — Prism doesn't add its own retry layer because Ponder, viem, and most indexer pipelines already have one.

The error you see tells you *why* it failed:

- **`RpcRequestError`** — a contract revert. Don't retry; the call is deterministic.
- **`Circuit open, ...`** — every tier failed recently and the breaker is rejecting fast. Wait it out.
- **`Queue full, ...`** (in `error.cause`) — the indexer is overwhelmed. Slow down.
- **`All RPCs failed for ...`** — every tier exhausted. Treat as a transient outage and retry.

## Configuration

```typescript
createPrismTransport({
  // Required
  chainName: "polygon",
  publicUrls: ["https://..."],

  // Optional tiers
  paidUrls: ["https://..."],
  hyperSyncUrls: ["https://..."],

  // Logging
  verbose: false,    // default: only warnings/errors are logged
  logger: myLogger,  // optional — inject Pino, Winston, or a no-op

  // HyperSync behavior
  disableHyperSyncBlockFetch: false, // skip HyperSync for block requests

  // Hard cap on response body size, in bytes. Guards against a misbehaving
  // provider OOMing the indexer with a multi-gigabyte response.
  maxResponseBytes: 50 * 1024 * 1024, // default: 50 MiB

  // Circuit breaker
  circuitBreaker: {
    failureThreshold: 5,   // consecutive failures before opening
    cooldownMs: 30_000,    // wait before half-open probe
  },

  // Round-robin pool
  pool: {
    failureThreshold: 5,   // evict URL after N consecutive failures
    cooldownMs: 300_000,   // re-add evicted URL after 5 minutes
  },

  // Fallback queue
  fallbackQueue: {
    concurrency: 10,        // max concurrent queue requests
    maxSize: 50,            // reject when queue is full (backpressure)
    totalTimeoutMs: 15_000, // hard timeout per queued request
  },

  // Timeouts
  timeouts: {
    default: 10_000,
    ethGetLogs: 15_000,
    ethGetLogsFallback: 10_000,
    ethGetLogsFallbackTotal: 15_000,
  },
});
```

## Observability

### Per-request hook

`onRequest` fires once per call with `{ chain, method, ok, durationMs, error? }` — wire it into Prometheus, OpenTelemetry, Datadog, or whatever your stack uses for latency and tracing:

```typescript
const { transport } = createPrismTransport({
  chainName: "polygon",
  publicUrls: [...],
  onRequest: (event) => {
    metrics.histogram("rpc.duration_ms", event.durationMs, {
      chain: event.chain,
      method: event.method,
      ok: String(event.ok),
    });
  },
});
```

Exceptions thrown from the hook are caught and logged — they never break the transport.

### Pool reset

After a known recovery event (region failover, DNS flap, scheduled provider maintenance ending), call `reset()` on a round-robin pool to immediately restore evicted URLs without waiting for the cooldown:

```typescript
import { createRoundRobinPool } from "prism-transport";

const pool = createRoundRobinPool([...], logger);
// later, after a known recovery event:
pool.reset();
```

### Lifecycle and graceful shutdown

When a transport is no longer needed (dynamic chain reconfiguration, app teardown), call `dispose()` to unregister from the shared registry and drop pending fallback-queue items:

```typescript
const { dispose } = createPrismTransport({ ... });
// ... later:
dispose();
```

In-flight network requests finish naturally; only queued waiters are dropped.

The registry also exposes `unregister(chain)` if you need finer-grained control:

```typescript
const removed = registry.unregister("polygon"); // returns true on success
```

### Deterministic round-robin (testing)

By default the round-robin cursor starts at a random index to spread cold-start load across URLs when many transports boot at once (e.g. across worker threads). For deterministic tests, pass `startIndex: 0` to `createRoundRobinPool`:

```typescript
const pool = createRoundRobinPool(["a", "b", "c"], logger, { startIndex: 0 });
pool.next(); // "a"
pool.next(); // "b"
```

### Stats

```typescript
const { transport, getStats } = createPrismTransport({ ... });

const stats = getStats();
// stats.tierCounters.public.requests
// stats.tierCounters.hyperSync.successes
// stats.circuitBreaker.state  // "CLOSED" | "OPEN" | "HALF_OPEN"
// stats.fallbackQueue.size
// stats.methodCounters["eth_getLogs"].total
```

### Multi-chain registry

```typescript
const { registry } = createPrismTransport({ chainName: "polygon", ... });

createPrismTransport({ chainName: "arbitrum", ... }, registry);

const allStats = registry.getAllStats();
// [{ chain: "polygon", ... }, { chain: "arbitrum", ... }]
```

### Cross-worker stats (optional)

For multi-threaded environments (e.g. Ponder's `worker_threads`):

```typescript
import { createStatsSync, readAllWorkerStats } from "prism-transport";

// In each worker thread:
const sync = createStatsSync({ statsDir: "/tmp/my-rpc-stats" });
sync.registerProvider("polygon", getStats);
sync.start();

// In the main thread (API server):
const stats = await readAllWorkerStats({ statsDir: "/tmp/my-rpc-stats" });
```

## Building blocks

Each component is exported individually for advanced use:

```typescript
import {
  createRoundRobinPool,
  createCircuitBreaker,
  createFallbackQueue,
  createTransportRegistry,
} from "prism-transport";
```

## License

MIT
