import { approveNoReturnAbi, quoterAbi, permit2Abi } from "./peripheryAbi.ts";
export { quoterAbi, universalRouterAbi, permit2Abi } from "./peripheryAbi.ts";
// Quotes and swap requests. CUBIT trades through the registry's CubitRouter, which delivers the CUBIT that crossed walls
// absorb right after a sale. Launchpad children have no router of their own: they trade through the canonical Uniswap
// Universal Router (one v4 exact-input swap, Permit2 for sales); their absorbed tokens wait until anyone delivers them.
import { type Address } from "viem";
import { CubitRouterAbi, CubitTokenAbi } from "./abi";
import { publicClient } from "./client";
import { CONFIG } from "./config";
import { marketKey, poolKeyOf, zeroForOneOf, type MarketRef } from "./market";
import { universalRouterEthBuy, universalRouterSwap, type V3Path } from "./swapEncoding.ts";
import { TX_GAS_CAP, type WriteRequest } from "./writeRequest.ts";

/** Router checks, settlement and the delivery of absorbed CUBIT around the pool swap the quoter measures. */
export const SALE_GAS_OVERHEAD = 400_000n;
export const SALE_TOO_LARGE = "This sale crosses too many walls for one transaction (about 88 per transaction). Split it into smaller sales.";

export type Quote = { out: bigint; gas: bigint };

/** Net output (taxes included: the hook's deltas are inside the quote) and the gas the pool swap measured. */
export async function quoteExactIn(ref: MarketRef, buy: boolean, amountIn: bigint, blockNumber?: bigint): Promise<Quote> {
  const { result } = await publicClient.simulateContract({
    blockNumber,
    address: CONFIG.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ poolKey: marketKey(ref), zeroForOne: zeroForOneOf(ref, buy), exactAmount: amountIn, hookData: "0x" }],
  });
  return { out: result[0], gas: result[1] };
}

export const saleFitsOneTransaction = (gas: bigint) => gas + SALE_GAS_OVERHEAD <= TX_GAS_CAP;

export async function chainDeadline(seconds = 1_200): Promise<bigint> {
  return (await publicClient.getBlock({ blockTag: "latest" })).timestamp + BigInt(seconds);
}

export function routerSwapRequest(router: Address, ref: MarketRef, buy: boolean, amountIn: bigint, minOut: bigint, recipient: Address, deadline: bigint): WriteRequest {
  return {
    address: router,
    abi: CubitRouterAbi,
    functionName: "swapExactIn",
    args: [poolKeyOf(ref.token, ref.hook), buy, amountIn, minOut, recipient, deadline],
    value: buy ? amountIn : 0n,
  };
}

/** One exact-input swap on a launchpad child through the configured Universal Router (see swapEncoding.ts). */
export function universalRouterSwapRequest(ref: MarketRef, buy: boolean, amountIn: bigint, minOut: bigint, deadline: bigint): WriteRequest {
  return universalRouterSwap(CONFIG.universalRouter, ref, buy, amountIn, minOut, deadline);
}

/** A launchpad v2 child with an ERC-20 pair, paid with ETH: ETH → the pair along `path` → the child, one transaction. */
export function universalRouterEthBuyRequest(ref: MarketRef, path: V3Path, amountIn: bigint, minOut: bigint, deadline: bigint): WriteRequest {
  return universalRouterEthBuy(CONFIG.universalRouter, ref, path, amountIn, minOut, deadline);
}

export async function tokenBalance(token: Address, owner: Address, blockNumber?: bigint): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: CubitTokenAbi, functionName: "balanceOf", args: [owner], blockNumber });
}

export async function tokenAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: CubitTokenAbi, functionName: "allowance", args: [owner, spender] });
}

export async function permit2Allowance(owner: Address, token: Address): Promise<{ amount: bigint; expiration: number }> {
  const [amount, expiration] = await publicClient.readContract({
    address: CONFIG.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, token, CONFIG.universalRouter],
  });
  return { amount, expiration: Number(expiration) };
}

export const approveRequest = (token: Address, spender: Address, amount: bigint): WriteRequest => ({
  address: token, abi: CubitTokenAbi, functionName: "approve", args: [spender, amount],
});

/** A launchpad token's or its pair's approval to Permit2: USDT returns no value (see approveNoReturnAbi). */
export const permit2TokenApproveRequest = (token: Address, amount: bigint): WriteRequest => ({
  address: token, abi: approveNoReturnAbi, functionName: "approve", args: [CONFIG.permit2, amount],
});

export const permit2ApproveRequest = (token: Address, amount: bigint, expiration: number): WriteRequest => ({
  address: CONFIG.permit2, abi: permit2Abi, functionName: "approve", args: [token, CONFIG.universalRouter, amount, expiration],
});
