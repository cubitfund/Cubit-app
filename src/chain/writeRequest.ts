import type { Abi, Address } from "viem";

/** EIP-7825 caps a transaction at 2^24 gas. */
export const TX_GAS_CAP = 16_777_216n;

export type WriteRequest = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

