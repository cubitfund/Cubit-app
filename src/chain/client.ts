import { createRelayRequest } from "./relayRequest.ts";
import { sessionToken, clearSession } from "./relaySession.ts";
// One read client. Wallet configuration contains only the public RPC; an optional build override stays here.
import { createPublicClient, custom, http } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { NETWORK } from "./deployment.ts";
import { CONFIG } from "./config";
import { RpcPolicy } from "./rpcPolicy";
import { classifyRpcError, withHeadLagRetry } from "./rpcErrors";
import { RequestPool } from "./requestPool";

export const chain = { ...(NETWORK === "sepolia" ? sepolia : mainnet), rpcUrls: { default: { http: [CONFIG.publicRpcUrl] } } };

// One bounded queue for every public fallback, including public data and independent verification.
// A node of the public endpoint can still be a block behind the head a read is pinned to: that refusal is
// retried, the wait happening outside the queue so that it holds no slot.
const publicPool = new RequestPool();
const fallback = (args: { method: string; params?: unknown }) => withHeadLagRetry(() => publicPool.run((signal) =>
  http(CONFIG.publicRpcUrl, { retryCount: 0, timeout: 10_000, fetchOptions: { signal } })({ chain, retryCount: 0 }).request(args)));

/** A private endpoint paced by RpcPolicy; its refusals and outages use the public RPC. */
function paced(url: string) {
  const policy = new RpcPolicy();
  // No transport retry or delayed HTTP batch: each start below is an actual RPC dispatch.
  const privateRpc = http(url, { retryCount: 0, timeout: 8_000 })({ chain, retryCount: 0 });
  return async (args: { method: string; params?: unknown }) => {
    const route = policy.route();
    for (;;) {
      const wait = policy.start(route);
      if (wait === null) return fallback(args);
      if (wait === 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    try {
      const result = await privateRpc.request(args);
      policy.answered(route);
      return result;
    } catch (error) {
      const kind = classifyRpcError(error);
      if (kind === "deterministic") { policy.answered(route); throw error; }
      if (kind === "rate") policy.rateLimited(route);
      else if (kind === "quota") policy.quotaExceeded(route);
      else if (kind === "outage") policy.failed(route);
      else policy.refused(route);
      return fallback(args);
    }
  };
}

// Reads the shared worker does not serve: the app's own endpoint when the build names one, else the public RPC.
const directRead = CONFIG.fallbackRpcUrl === CONFIG.publicRpcUrl ? fallback : paced(CONFIG.fallbackRpcUrl);

function readTransport() {
  if (CONFIG.dataUrl) return custom({ request: createRelayRequest({ url: CONFIG.dataUrl, token: sessionToken, clearToken: clearSession, fallback: directRead }) }, { retryCount: 0 });
  return custom({ request: CONFIG.rpcUrl === CONFIG.publicRpcUrl ? fallback : paced(CONFIG.rpcUrl) }, { retryCount: 0 });
}

export const publicClient = createPublicClient({
  chain,
  // Multicall groups compatible reads in a 16 ms window. Size, block and context can split them into several calls.
  batch: { multicall: { wait: 16 } },
  transport: readTransport(),
  pollingInterval: 4_000,
});

// Data fallback and block check, never through the relay: the app's own endpoint when the build names one.
export const directPublicClient = createPublicClient({
  chain, batch: { multicall: { wait: 16 } }, transport: custom({ request: directRead }, { retryCount: 0 }),
});
