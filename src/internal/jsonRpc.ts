/**
 * Internal JSON-RPC 2.0 shapes and helpers.
 *
 * Not exported from the package entrypoint — these types describe wire format
 * only and are not part of the public API.
 */

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: P;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: R;
  error?: JsonRpcError;
}

/**
 * Extract the hostname from a URL for log readability. Falls back to the raw
 * input when the URL is malformed (e.g. test fixtures like `http://x.invalid`).
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Strip path, query, and userinfo from a URL — leaving only `scheme://host[:port]`.
 * Used when surfacing a URL in errors that may cross trust boundaries (logs,
 * Sentry, viem `RpcRequestError`) so embedded API keys never leak.
 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return `https://${hostOf(url)}`;
  }
}

/**
 * Standard EVM JSON-RPC error code for a contract revert (EIP-1474).
 *
 * Reverts are deterministic and non-retryable, so the transport surfaces them
 * as a typed error instead of attempting the next tier.
 */
export const CONTRACT_REVERT_CODE = 3;
