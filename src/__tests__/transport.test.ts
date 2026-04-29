import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismTransport } from "../transport";

/**
 * Integration-level tests for the tiered transport router.
 *
 * Uses a mocked global fetch to simulate RPC responses without hitting
 * real endpoints. Tests verify that the correct tier routing and fallback
 * logic is applied based on the RPC method.
 */

function makeJsonRpcResponse(result: any, id: number = 1) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeErrorResponse(message: string, code = -32000, id = 1) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type Requester = (args: { method: string; params: unknown[] }) => Promise<unknown>;

/**
 * Instantiate a viem custom transport and extract its `request` function so a
 * test can drive RPC calls directly without spinning up a full client.
 *
 * viem has shipped two shapes for the value returned by `transport({...})`:
 * one with the requester at `value.request` and one at the top level. Probe
 * both so the suite is portable across viem versions.
 */
function getRequester(transport: ReturnType<typeof createPrismTransport>["transport"]): Requester {
  const created = transport({ chain: { id: 1 } as any, retryCount: 0 }) as {
    value?: { request?: Requester };
    request?: Requester;
  };
  const req = created.value?.request ?? created.request;
  if (!req) throw new Error("Could not extract request function from transport");
  return req;
}

/** Read the URL passed to the n-th `fetch` call. Asserts the call exists. */
function fetchUrlAt(mock: ReturnType<typeof vi.fn>, n: number): string {
  const call = mock.mock.calls[n];
  if (!call) throw new Error(`Expected fetch call #${n}, got ${mock.mock.calls.length} calls`);
  return call[0] as string;
}

describe("createPrismTransport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes eth_getLogs to HyperSync first", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonRpcResponse([]));

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      hyperSyncUrls: ["http://hypersync.rpc"],
    });

    const request = getRequester(transport);
    await request({ method: "eth_getLogs", params: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrlAt(fetchMock, 0)).toBe("http://hypersync.rpc");
  });

  it("falls through from HyperSync to paid on eth_getLogs failure", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("HyperSync down"))
      .mockResolvedValueOnce(makeJsonRpcResponse([]));

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      hyperSyncUrls: ["http://hypersync.rpc"],
      paidUrls: ["http://paid.rpc"],
    });

    const request = getRequester(transport);
    await request({ method: "eth_getLogs", params: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchUrlAt(fetchMock, 1)).toBe("http://paid.rpc");
  });

  it("routes regular methods to public first", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonRpcResponse("0x1"));

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      hyperSyncUrls: ["http://hypersync.rpc"],
    });

    const request = getRequester(transport);
    await request({ method: "eth_chainId", params: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrlAt(fetchMock, 0)).toBe("http://public.rpc");
  });

  it("does not retry contract reverts", async () => {
    fetchMock.mockResolvedValueOnce(makeErrorResponse("execution reverted", 3));

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      paidUrls: ["http://paid.rpc"],
    });

    const request = getRequester(transport);
    await expect(
      request({ method: "eth_call", params: [] }),
    ).rejects.toThrow();

    // Should only call once — no fallback for reverts
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls through public → HyperSync → paid for regular methods", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("public down"))
      .mockRejectedValueOnce(new Error("hypersync down"))
      .mockResolvedValueOnce(makeJsonRpcResponse("0x1"));

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      hyperSyncUrls: ["http://hypersync.rpc"],
      paidUrls: ["http://paid.rpc"],
    });

    const request = getRequester(transport);
    await request({ method: "eth_chainId", params: [] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchUrlAt(fetchMock, 0)).toBe("http://public.rpc");
    expect(fetchUrlAt(fetchMock, 1)).toBe("http://hypersync.rpc");
    expect(fetchUrlAt(fetchMock, 2)).toBe("http://paid.rpc");
  });

  it("circuit breaker rejects after threshold failures", async () => {
    fetchMock.mockRejectedValue(new Error("all down"));

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      circuitBreaker: { failureThreshold: 1 },
    });

    const request = getRequester(transport);

    // First call fails normally — triggers circuit breaker
    await expect(
      request({ method: "eth_chainId", params: [] }),
    ).rejects.toThrow();

    // Second call should be rejected by circuit breaker immediately
    await expect(
      request({ method: "eth_chainId", params: [] }),
    ).rejects.toThrow("Circuit open");
  });

  it("getStats returns accurate tier counters", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeJsonRpcResponse("0x1"))
    );

    const { transport, getStats } = createPrismTransport({
      chainName: "polygon",
      publicUrls: ["http://public.rpc"],
    });

    const request = getRequester(transport);
    await request({ method: "eth_chainId", params: [] });
    await request({ method: "eth_chainId", params: [] });

    const stats = getStats();
    expect(stats.chain).toBe("polygon");
    expect(stats.tierCounters.public.requests).toBe(2);
    expect(stats.tierCounters.public.successes).toBe(2);
    expect(stats.methodCounters["eth_chainId"]?.total).toBe(2);
  });

  it("skips HyperSync for eth_getBlockByNumber with tag params", async () => {
    fetchMock.mockResolvedValueOnce(makeJsonRpcResponse({ number: "0x1" }));

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      hyperSyncUrls: ["http://hypersync.rpc"],
    });

    const request = getRequester(transport);
    await request({ method: "eth_getBlockByNumber", params: ["latest", false] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrlAt(fetchMock, 0)).toBe("http://public.rpc"); // NOT hypersync
  });

  it("validates HyperSync block response for hex params", async () => {
    // HyperSync returns wrong block number → should fall through to public
    fetchMock
      .mockResolvedValueOnce(makeJsonRpcResponse({ number: "0x999" })) // wrong block
      .mockResolvedValueOnce(makeJsonRpcResponse({ number: "0x100" })); // correct from public

    const { transport } = createPrismTransport({
      chainName: "test",
      publicUrls: ["http://public.rpc"],
      hyperSyncUrls: ["http://hypersync.rpc"],
    });

    const request = getRequester(transport);
    const result = (await request({
      method: "eth_getBlockByNumber",
      params: ["0x100", false],
    })) as { number: string };

    expect(result.number).toBe("0x100");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a shared registry for multi-chain setups", () => {
    const { registry: r1 } = createPrismTransport({
      chainName: "polygon",
      publicUrls: ["http://a.rpc"],
    });

    createPrismTransport({
      chainName: "arbitrum",
      publicUrls: ["http://b.rpc"],
    }, r1);

    const allStats = r1.getAllStats();
    expect(allStats).toHaveLength(2);
    expect(allStats.map((s) => s.chain).sort()).toEqual(["arbitrum", "polygon"]);
  });

  it("redacts URL credentials from stats output", async () => {
    fetchMock.mockResolvedValue(makeJsonRpcResponse("0x1"));

    const { transport, getStats } = createPrismTransport({
      chainName: "secret",
      publicUrls: ["https://eth.publicnode.com/v2/PUBLIC_KEY_1"],
      paidUrls:   ["https://api.alchemy.com/v2/SECRET_API_KEY"],
    });

    const request = getRequester(transport);
    await request({ method: "eth_chainId", params: [] });

    const stats = getStats();
    const serialised = JSON.stringify(stats);
    expect(serialised).not.toContain("PUBLIC_KEY_1");
    expect(serialised).not.toContain("SECRET_API_KEY");
    expect(stats.publicPool.urls).toEqual(["eth.publicnode.com"]);
    expect(stats.paidUrls).toEqual(["api.alchemy.com"]);
    // Counters keyed by hostname, not full URL.
    expect(stats.publicPool.totalRequests["eth.publicnode.com"]).toBe(1);
  });

  it("does not pollute Object.prototype when method is __proto__", async () => {
    fetchMock.mockRejectedValue(new Error("never resolves"));

    const { transport, getStats } = createPrismTransport({
      chainName: "secure",
      publicUrls: ["http://public.rpc"],
    });

    const request = getRequester(transport);
    await expect(request({ method: "__proto__", params: [] })).rejects.toThrow();

    // Critical: Object.prototype must remain untouched.
    expect(({} as Record<string, unknown>).total).toBeUndefined();
    expect(getStats().methodCounters["__proto__"]?.total).toBe(1);
  });

  it("preserves the queue's failure reason as `cause` when all tiers fail", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "http://public.rpc") return Promise.reject(new Error("public down"));
      return new Promise((_, reject) => setTimeout(() => reject(new Error("paid slow")), 100));
    });

    const { transport } = createPrismTransport({
      chainName: "cause",
      publicUrls: ["http://public.rpc"],
      paidUrls:   ["http://paid.rpc"],
      fallbackQueue: { concurrency: 1, maxSize: 1, totalTimeoutMs: 500 },
      circuitBreaker: { failureThreshold: 1000 },
    });
    const request = getRequester(transport);

    // Saturate the queue: first call holds the only slot, second is rejected
    // synchronously with "Queue full" — that error must surface as `cause`.
    const inFlight = request({ method: "eth_chainId", params: [] }).catch(() => {});
    const failure = await request({ method: "eth_chainId", params: [] }).catch((e) => e);
    await inFlight;

    // Walk the cause chain: viem wraps our error in UnknownRpcError, then our
    // allTiersFailed wraps the underlying "Queue full" rejection as `cause`.
    const messages: string[] = [];
    for (let e: unknown = failure; e instanceof Error; e = (e as Error).cause) {
      messages.push(e.message);
    }
    expect(failure).toBeInstanceOf(Error);
    expect(messages.some((m) => /Queue full/.test(m))).toBe(true);
  });

  it("dispose() unregisters the chain from the shared registry", () => {
    const registry = createPrismTransport({
      chainName: "polygon",
      publicUrls: ["http://a.rpc"],
    }).registry;

    const { dispose } = createPrismTransport({
      chainName: "arbitrum",
      publicUrls: ["http://b.rpc"],
    }, registry);

    expect(registry.getAllStats().map((s) => s.chain).sort()).toEqual(["arbitrum", "polygon"]);
    dispose();
    expect(registry.getAllStats().map((s) => s.chain)).toEqual(["polygon"]);
  });

  it("warns when registering the same chain twice", () => {
    const warn = vi.fn();
    const customLogger = { info: vi.fn(), warn, error: vi.fn(), success: vi.fn() };

    const { registry } = createPrismTransport({
      chainName: "polygon",
      publicUrls: ["http://a.rpc"],
      logger: customLogger,
    });

    createPrismTransport({
      chainName: "polygon",
      publicUrls: ["http://c.rpc"],
      logger: customLogger,
    }, registry);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Overwriting existing registration for "polygon"'));
  });
});
