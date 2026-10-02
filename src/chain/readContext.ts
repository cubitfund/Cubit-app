import type { PublicClient, Hex } from "viem";
import type { DEPLOYMENT } from "./deployment.ts";

/** Environment-neutral inputs: no browser globals, React, transport construction or build variables. */
export type ReadContext = {
  client: Pick<PublicClient, "readContract" | "multicall" | "getLogs" | "getContractEvents" | "getBlock" | "getCode">;
  config: Pick<typeof DEPLOYMENT, "chainId" | "token" | "hook" | "v2" | "poolManager" | "poolId" | "deployBlock" | "forge" | "launchpadDeployBlock" | "bandLib" | "wallLib">;
};
export type BlockSnapshot = { number: bigint; hash: Hex; timestamp: bigint };

/** An explicit wallet action still needs a fresh block while periodic polling is paused.
 *  The direct read does not resume the clock; cancellation is checked on both sides of each await. */
export async function readActionBlock(
  ctx: ReadContext, refresh: () => Promise<BlockSnapshot | null>, check: () => void,
): Promise<BlockSnapshot> {
  check();
  const shared = await refresh();
  check();
  if (shared) return shared;
  const block = await ctx.client.getBlock({ blockTag: "latest" });
  check();
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}

/** The read block left the canonical chain: the figures just read belong to an orphaned branch. */
export class BlockChangedError extends Error {
  constructor() { super("The block changed while reading; retrying the snapshot."); this.name = "BlockChangedError"; }
}

/** Reject a snapshot if a reorg or an inconsistent provider changed its head while it was being read. */
export async function assertBlock(ctx: ReadContext, block: BlockSnapshot) {
  const current = await ctx.client.getBlock({ blockNumber: block.number });
  if (current.hash !== block.hash) throw new BlockChangedError();
}
