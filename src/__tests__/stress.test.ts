import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismTransport } from "../transport";
import type { PrismRequestEvent } from "../types";

/**
 * Concurrency / observability tests for the top-level transport.
 *
 * These exercise the failure paths *under load* — many in-flight requests at
 * once, partial outages, queue saturation — to catch regressions that
 * single-request happy-path tests miss.
 */

function jsonRpcResponse(result: unknown, id = 1): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type Requester = (args: { method: string; params: unknown[] }) => Promise<unknown>;

function getRequester(transport: ReturnType<typeof createPrismTransport>["transport"]): Requester {
  const created = transport({ chain: { id: 1 } as any, retryCount: 0 }) as {
    value?: { request?: Requester };
    request?: Requester;
  };
  const req = created.value?.request ?? created.request;
  if (!req) throw new Error("Could not extract request function");
  return req;
}

describe("createPrismTransport — stress & observability", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles 1000 concurrent successful requests without unhandled rejections", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonRpcResponse("0x1")));

    const { transport, getStats } = createPrismTransport({
      chainName: "stress",
      publicUrls: ["http://public.rpc"],
    });
    const request = getRequester(transport);

    const results = await Promise.allSettled(
      Array.from({ length: 1000 }, () => request({ method: "eth_chainId", params: [] })),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1000);
    expect(getStats().tierCounters.public.successes).toBe(1000);
    expect(getStats().methodCounters["eth_chainId"]?.total).toBe(1000);
  });

  it("falls through to paid for 50 concurrent requests when public is down", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "http://public.rpc") return Promise.reject(new Error("public down"));
      return Promise.resolve(jsonRpcResponse("0x1"));
    });

    const { transport, getStats } = createPrismTransport({
      chainName: "stress",
      publicUrls: ["http://public.rpc"],
      paidUrls: ["http://paid.rpc"],
      // Loosen breaker so it doesn't trip mid-test.
      circuitBreaker: { failureThreshold: 1000 },
    });
    const request = getRequester(transport);

    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, () => request({ method: "eth_chainId", params: [] })),
    );

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(50);
    const tiers = getStats().tierCounters;
    expect(tiers.public.failures).toBe(50);
    expect(tiers.paid.successes).toBe(50);
    expect(tiers.queue.successes).toBe(0); // never reached the fallback queue
  });

  it("rejects with queue-full backpressure when the fallback queue is saturated", async () => {
    // Public fails fast; paid is slow-failing — forces every call into the queue.
    fetchMock.mockImplementation((url: string) => {
      if (url === "http://public.rpc") return Promise.reject(new Error("public down"));
      return new Promise((_, reject) => setTimeout(() => reject(new Error("paid slow")), 100));
    });

    const { transport, getStats } = createPrismTransport({
      chainName: "stress",
      publicUrls: ["http://public.rpc"],
      paidUrls: ["http://paid.rpc"],
      fallbackQueue: { concurrency: 1, maxSize: 2, totalTimeoutMs: 500 },
      circuitBreaker: { failureThreshold: 1000 },
    });
    const request = getRequester(transport);

    // Fire 5 in parallel. The queue accepts at most 2 (concurrency 1 + 1 waiting);
    // the rest are rejected with "Queue full" *inside* the transport, which then
    // surfaces as a generic "All RPCs failed" at the request layer. Inspect the
    // queue stats to confirm backpressure actually fired.
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => request({ method: "eth_chainId", params: [] })),
    );

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(0);
    const queueStats = getStats().fallbackQueue;
    expect(queueStats.totalQueued).toBeGreaterThanOrEqual(1);
    expect(queueStats.totalRejected).toBeGreaterThanOrEqual(1);
    // The queue must have observed real backpressure.
    expect(queueStats.totalQueued + queueStats.totalRejected).toBe(5);
  });

  it("fires onRequest exactly once per call (success and failure)", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRpcResponse("0x1"))   // first success
      .mockRejectedValue(new Error("everything down")); // subsequent fail

    const events: PrismRequestEvent[] = [];
    const { transport } = createPrismTransport({
      chainName: "obs",
      publicUrls: ["http://public.rpc"],
      onRequest: (e) => events.push(e),
      // Trip immediately on second call so the breaker contributes one event too.
      circuitBreaker: { failureThreshold: 1 },
    });
    const request = getRequester(transport);

    await request({ method: "eth_chainId", params: [] });           // ok
    await expect(request({ method: "eth_chainId", params: [] })).rejects.toThrow();    // tier failure
    await expect(request({ method: "eth_chainId", params: [] })).rejects.toThrow(/Circuit/); // breaker

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.ok)).toEqual([true, false, false]);
    expect(events.every((e) => e.chain === "obs")).toBe(true);
    expect(events.every((e) => typeof e.durationMs === "number" && e.durationMs >= 0)).toBe(true);
  });

  it("isolates onRequest hook errors from the transport", async () => {
    fetchMock.mockResolvedValue(jsonRpcResponse("0x1"));

    const { transport } = createPrismTransport({
      chainName: "obs",
      publicUrls: ["http://public.rpc"],
      onRequest: () => {
        throw new Error("hook is broken");
      },
    });
    const request = getRequester(transport);

    // Hook error must NOT propagate to the caller.
    await expect(request({ method: "eth_chainId", params: [] })).resolves.toBe("0x1");
  });
});
