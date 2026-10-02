// Pure encoding of a launchpad child's swap through the Uniswap Universal Router: no client, no build variables, so the
// same code serves the app, its tests and scripts. A buy pays the pool's quote (native ETH as the call's value, an
// ERC-20 through Permit2); a sale pays the child token through Permit2 and takes the quote.
import { encodeAbiParameters, encodePacked, zeroAddress, type Address, type Hex } from "viem";
import { poolKeyComponents, universalRouterAbi } from "./peripheryAbi.ts";
import { marketKey, zeroForOneOf, type MarketRef } from "./market.ts";
import type { WriteRequest } from "./writeRequest.ts";

// V4Router exact-input layout used by the configured Universal Router.
const exactInputSingleParams = [{
  type: "tuple",
  components: [
    { name: "poolKey", type: "tuple", components: poolKeyComponents },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "hookData", type: "bytes" },
  ],
}] as const;

export const V4_SWAP = "0x10";
export const SWAP_EXACT_IN_SINGLE = 0x06;
export const SETTLE_ALL = 0x0c;
export const TAKE_ALL = 0x0f;

export function universalRouterSwap(
  universalRouter: Address, ref: MarketRef, buy: boolean, amountIn: bigint, minOut: bigint, deadline: bigint,
): WriteRequest {
  const swap = encodeAbiParameters(exactInputSingleParams, [{
    poolKey: marketKey(ref), zeroForOne: zeroForOneOf(ref, buy), amountIn, amountOutMinimum: minOut, hookData: "0x",
  }]);
  const quote = ref.quote?.address ?? zeroAddress;
  const [paid, bought] = buy ? [quote, ref.token] : [ref.token, quote];
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [paid, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [bought, minOut]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swap, settle, take]]);
  return {
    address: universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [V4_SWAP, [input], deadline],
    value: buy && quote === zeroAddress ? amountIn : 0n,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Paying an ERC-20 pair with ETH: the Universal Router wraps the ETH, swaps it along a Uniswap v3 path to the pair, and
// (for a child buy) settles that pair into the child's v4 pool in the same transaction. Commands and constants are the
// Universal Router's (Commands.sol, ActionConstants.sol).
export const WRAP_ETH = 0x0b;
export const V3_SWAP_EXACT_IN = 0x00;
export const SETTLE = 0x0b; // v4 action, not the router command of the same value
/** Recipient placeholders the router resolves: the caller, or the router itself. */
export const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
/** "Everything the router holds" as an amount, and "the whole open credit" for a v4 exact-input swap. */
export const CONTRACT_BALANCE = 1n << 255n;
export const OPEN_DELTA = 0n;

export type V3Path = { tokens: Address[]; fees: number[] };

/** Uniswap v3 packed path: token, fee (uint24), token, … */
export function encodeV3Path(path: V3Path): Hex {
  if (path.tokens.length !== path.fees.length + 1 || path.fees.length === 0) throw new Error("Invalid v3 path.");
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  path.tokens.forEach((token, i) => {
    types.push("address"); values.push(token);
    if (i < path.fees.length) { types.push("uint24"); values.push(path.fees[i]); }
  });
  return encodePacked(types, values);
}

const wrapInput = (amount: bigint) => encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ADDRESS_THIS, amount]);
const v3Input = (recipient: Address, amountIn: bigint, minOut: bigint, path: V3Path) => encodeAbiParameters(
  [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
  [recipient, amountIn, minOut, encodeV3Path(path), false],
);

/** ETH → the pair along `path`, delivered to the caller. The launch's first buy uses it before the Forge pulls the pair. */
export function universalRouterEthToQuote(universalRouter: Address, path: V3Path, amountIn: bigint, minOut: bigint, deadline: bigint): WriteRequest {
  return {
    address: universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [encodePacked(["uint8", "uint8"], [WRAP_ETH, V3_SWAP_EXACT_IN]), [wrapInput(amountIn), v3Input(MSG_SENDER, amountIn, minOut, path)], deadline],
    value: amountIn,
  };
}

/** One transaction: ETH → the pair along `path` (held by the router), then the pair → the child in its v4 pool. Only
 *  the final output is bounded: a worse first hop simply yields fewer child tokens, and `minOut` refuses that. */
export function universalRouterEthBuy(
  universalRouter: Address, ref: MarketRef, path: V3Path, amountIn: bigint, minOut: bigint, deadline: bigint,
): WriteRequest {
  const quote = ref.quote?.address ?? zeroAddress;
  if (quote === zeroAddress || path.tokens[path.tokens.length - 1].toLowerCase() !== quote.toLowerCase()) throw new Error("The path does not end in this pair.");
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [quote, CONTRACT_BALANCE, false]);
  const swap = encodeAbiParameters(exactInputSingleParams, [{
    poolKey: marketKey(ref), zeroForOne: zeroForOneOf(ref, true), amountIn: OPEN_DELTA, amountOutMinimum: minOut, hookData: "0x",
  }]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ref.token, minOut]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [SETTLE, SWAP_EXACT_IN_SINGLE, TAKE_ALL]);
  const v4 = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [settle, swap, take]]);
  return {
    address: universalRouter,
    abi: universalRouterAbi,
    functionName: "execute",
    args: [encodePacked(["uint8", "uint8", "uint8"], [WRAP_ETH, V3_SWAP_EXACT_IN, Number(V4_SWAP)]),
      [wrapInput(amountIn), v3Input(ADDRESS_THIS, amountIn, 0n, path), v4], deadline],
    value: amountIn,
  };
}
