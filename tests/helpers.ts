import type { Address, Hex } from "viem";
import type { BlockSnapshot, ReadContext } from "../src/chain/readContext.ts";
export const address = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
export const hash = (n: number, branch = 0): Hex => `0x${(n * 100 + branch).toString(16).padStart(64, "0")}`;
export const head = (n: number, branch = 0): BlockSnapshot => ({ number: BigInt(n), hash: hash(n, branch), timestamp: BigInt(n * 12) });
export const lensSnapshot = (block: BlockSnapshot) => ({
  floorPrice: 0n, netFloorPrice: 0n, pendingFloorEth: 2n, pendingAbsorbedTokens: 3n,
  totalSupply: 21_000_000n, activeWallCount: 0n, rewardReserve: 5n, totalBurned: 0n,
  wallTickLower: 0, wallLiquidity: 0n, bandEth: 0n, bandTokens: 2n, marketPrice: 0n,
  tick: 150_000, teamAccrued: 0n, teamPaidCumulative: 0n, blockNumber: block.number,
  bestWallPrice: 0n, netBestWallPrice: 0n,
});
export const config = {
  chainId: 1, token: address(1), hook: address(2), v2: address(3), poolManager: address(4), poolId: hash(1),
  deployBlock: 1n, forge: address(5), launchpadDeployBlock: 3n, bandLib: address(6), wallLib: address(7),
};
export const context = (client: Record<string, unknown>): ReadContext => ({ config, client: client as ReadContext["client"] });
export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
