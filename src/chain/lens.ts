import type { Address } from "viem";
import { CubitLensAbi } from "./abi.ts";
import type { BlockSnapshot, ReadContext } from "./readContext.ts";

/** Caller policy, shared by browser and Worker. Change this without redeploying the Lens. */
export const WALL_TOTALS_PAGE_SIZE = 500n;

export type LensSnapshot = Awaited<ReturnType<typeof readLens>>;

/** Reconstruct the dashboard figures once, from one immutable block and complete wall pages.
 * Hash pinning (EIP-1898) also disables viem's automatic multicall aggregation for these reads:
 * every page retains its own gas budget. Never retry an unsupported hash selector at `latest`.
 */
export async function readLens(
  { client }: ReadContext, lens: Address, block: BlockSnapshot, pageSize = WALL_TOTALS_PAGE_SIZE,
) {
  if (pageSize <= 0n || pageSize >= 1n << 256n) throw new Error("Invalid wall page size.");
  const at = { address: lens, abi: CubitLensAbi, blockHash: block.hash, requireCanonical: true } as const;
  const snapshot = await client.readContract({ ...at, functionName: "snapshot" });
  if (snapshot.blockNumber !== block.number) throw new Error("The Lens answered for another block; retrying.");
  let wallEth = 0n, wallPrincipalTokens = 0n;
  for (let start = 0n; start < snapshot.activeWallCount;) {
    const [eth, tokens, next, total] = await client.readContract({
      ...at, functionName: "wallAmountsPage", args: [start, pageSize],
    });
    const expectedNext = start + pageSize < total ? start + pageSize : total;
    if (total !== snapshot.activeWallCount || next !== expectedNext || next <= start)
      throw new Error("Inconsistent wall page; retrying the snapshot.");
    wallEth += eth;
    wallPrincipalTokens += tokens;
    start = next;
  }
  // Pending CUBIT are outside the active positions; count them exactly once, even when there are no walls.
  const wallTokens = wallPrincipalTokens + snapshot.pendingAbsorbedTokens;
  const excluded = wallTokens + snapshot.rewardReserve;
  const circulatingSupply = snapshot.totalSupply > excluded ? snapshot.totalSupply - excluded : 0n;
  const heldSupply = circulatingSupply > snapshot.bandTokens ? circulatingSupply - snapshot.bandTokens : 0n;
  return { ...snapshot, wallEth, wallTokens, circulatingSupply, heldSupply };
}
