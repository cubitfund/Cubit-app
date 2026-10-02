import { parseAbi } from "viem";

export const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const quoterAbi = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [{
    name: "params",
    type: "tuple",
    components: [
      { name: "poolKey", type: "tuple", components: poolKeyComponents },
      { name: "zeroForOne", type: "bool" },
      { name: "exactAmount", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

/** ERC-20 `approve` declared without a return value: USDT returns none, and a simulation decoding a `bool` would
 *  refuse it before the wallet is asked. Tokens that return `true` are unaffected; every step after an approval
 *  reads the allowance again, so a token answering `false` cannot slip through. */
export const approveNoReturnAbi = parseAbi(["function approve(address spender, uint256 amount)"]);

export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
export const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);


/** Uniswap v3 QuoterV2: exact-input quote along a packed path (a simulation, never sent). */
export const v3QuoterAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
