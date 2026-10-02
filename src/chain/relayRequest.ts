import { RELAY_METHODS } from "./rpcMethods.ts";
import { RequestPool } from "./requestPool.ts";
type Args = { method: string; params?: unknown };
type RpcValue = { result?: unknown; error?: { code: number; message: string; data?: string } };
type RelayReply = { ok: true; value: RpcValue } | { ok: false; status: number };
const DETERMINISTIC_REFUSALS = new Set([400, 403, 413, 415, 422]);
/** Missing/expired sessions and unavailable or refusing relays use the bounded public transport.
 * Forward the caller's EIP-1898 selector unchanged on EVERY fallback. The caller must pin reads that
 * extend a snapshot: the relay's server-side pinning cannot protect requests that bypass the relay. */
export function createRelayRequest(options: {
  url: string; token: () => string | null; clearToken?: () => void;
  fallback: (args: Args) => Promise<unknown>; request?: typeof fetch; now?: () => number;
}) {
  const pool = new RequestPool();
  const now = options.now ?? Date.now;
  let pausedUntil = 0, id = 0;
  return async (args: Args) => {
    const token = options.token();
    if (!RELAY_METHODS.has(args.method) || !token || now() < pausedUntil) return options.fallback(args);
    let reply: RelayReply;
    try {
      reply = await pool.run(async (signal): Promise<RelayReply> => {
        const response = await (options.request ?? fetch)(`${options.url}/rpc`, {
          method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: args.method, params: args.params ?? [] }),
        });
        if (!response.ok) return { ok: false, status: response.status };
        return { ok: true, value: await response.json() };
      });
    } catch { pausedUntil = Math.max(pausedUntil, now() + 30_000); return options.fallback(args); }
    if (!reply.ok) {
      if (reply.status === 401) options.clearToken?.();
      // Retrying later cannot fix a deterministic refusal; only this call uses the public RPC.
      if (!DETERMINISTIC_REFUSALS.has(reply.status)) {
        pausedUntil = Math.max(pausedUntil, now() + (reply.status === 429 ? 60_000 : 30_000));
      }
      return options.fallback(args);
    }
    const { value } = reply;
    if (value.error) {
      // Preserve a simulated revert for viem's transaction UI. Infrastructure refusals use the public RPC.
      if (value.error.code === 3) throw value.error;
      return options.fallback(args);
    }
    if (!("result" in value)) return options.fallback(args);
    return value.result;
  };
}
