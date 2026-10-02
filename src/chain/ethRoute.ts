// Paying a launchpad v2 child's ERC-20 pair with ETH. The route is a Uniswap v3 path from WETH to the pair, direct or
// through the network's hub (USDC): tokenized stocks trade against USDC, stablecoins and WBTC directly against WETH.
// The best path is searched once per pair and amount size and kept a few minutes; later quotes reuse it, so a quote
// refresh costs one QuoterV2 simulation instead of a dozen.
import { HttpRequestError, RpcRequestError, TimeoutError, type Address, zeroAddress } from "viem";
import { v3QuoterAbi } from "./peripheryAbi.ts";
import { encodeV3Path, type V3Path } from "./swapEncoding.ts";

export type EthRouteConfig = { weth: Address; v3Quoter: Address; routeHub: Address };
type Client = { simulateContract: (args: never) => Promise<{ result: unknown }> };

const DIRECT_FEES = [100, 500, 3_000, 10_000];
const HUB_FEES = [100, 500, 3_000];
const LAST_FEES = [100, 500, 3_000, 10_000];
const ROUTE_TTL_MS = 5 * 60_000;

/** Every v3 path this app tries from WETH to `quote`, direct first. */
export function candidatePaths(cfg: EthRouteConfig, quote: Address): V3Path[] {
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
  if (quote === zeroAddress || same(quote, cfg.weth)) return [];
  const paths: V3Path[] = DIRECT_FEES.map((fee) => ({ tokens: [cfg.weth, quote], fees: [fee] }));
  if (!same(quote, cfg.routeHub)) {
    for (const a of HUB_FEES) for (const b of LAST_FEES) paths.push({ tokens: [cfg.weth, cfg.routeHub, quote], fees: [a, b] });
  }
  return paths;
}

export type EthQuote = { path: V3Path; out: bigint; gas: bigint };

/** A failure of the endpoint (unreachable, timed out, rate limited), as opposed to a quote that reverts because a pool
 *  of the path is missing or empty: the first must surface as an error, never as "no route". */
export function isTransportError(error: unknown): boolean {
  const e = error as { walk?: (f: (x: unknown) => boolean) => unknown } | null;
  const found = e?.walk?.((x) => x instanceof HttpRequestError || x instanceof TimeoutError ||
    (x instanceof RpcRequestError && (x.code === 429 || x.code === -32005 || x.code === -32603 && /rate|limit|timeout/i.test(x.message))));
  return !!found || error instanceof HttpRequestError || error instanceof TimeoutError;
}

/** The pair `amountIn` wei buys along `path`, or null when a pool of the path is missing or empty. An endpoint failure
 *  is thrown. */
export async function quoteEthPath(client: Client, cfg: EthRouteConfig, path: V3Path, amountIn: bigint, blockNumber?: bigint): Promise<EthQuote | null> {
  try {
    const { result } = await client.simulateContract({
      address: cfg.v3Quoter, abi: v3QuoterAbi, functionName: "quoteExactInput", args: [encodeV3Path(path), amountIn], blockNumber,
    } as never);
    const [out, , , gas] = result as readonly [bigint, unknown, unknown, bigint];
    return out > 0n ? { path, out, gas } : null;
  } catch (error) {
    if (isTransportError(error)) throw error;
    return null;
  }
}

const cache = new Map<string, { path: V3Path; at: number }>();
/** Size class of an amount (powers of ten), so a much larger buy searches again: the best pool depends on depth. */
const sizeClass = (amount: bigint) => amount.toString().length;

/** The path giving the most of the pair for `amountIn`, or null when no route exists. */
export async function bestEthRoute(
  client: Client, cfg: EthRouteConfig, quote: Address, amountIn: bigint, blockNumber?: bigint, now = Date.now(),
): Promise<EthQuote | null> {
  const key = `${cfg.v3Quoter}:${quote.toLowerCase()}:${sizeClass(amountIn)}`;
  const kept = cache.get(key);
  if (kept && now - kept.at < ROUTE_TTL_MS) {
    const q = await quoteEthPath(client, cfg, kept.path, amountIn, blockNumber);
    if (q) return q;
  }
  const quotes = await Promise.all(candidatePaths(cfg, quote).map((p) => quoteEthPath(client, cfg, p, amountIn, blockNumber)));
  let best: EthQuote | null = null;
  for (const q of quotes) if (q && (!best || q.out > best.out)) best = q;
  if (best) cache.set(key, { path: best.path, at: now });
  else cache.delete(key);
  return best;
}

/** "WETH → USDC (0.05%) → TSLAon (1%)" */
export function describePath(path: V3Path, symbols: Record<string, string>): string {
  return path.tokens.map((t, i) => {
    const name = symbols[t.toLowerCase()] ?? `${t.slice(0, 6)}…`;
    return i === 0 ? name : `${name} (${path.fees[i - 1] / 10_000}%)`;
  }).join(" → ");
}
