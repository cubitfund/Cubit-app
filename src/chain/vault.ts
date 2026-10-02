// The staking vault: CUBIT rewards at DAILY_REWARD_BPS of the stake per REWARD_PERIOD, capped at one period, paid from
// the vault's own reserve. The registry lists every vault, current and retired: a retired vault keeps its stakers'
// principal and reserve, so positions there stay withdrawable and claimable.
import type { Address } from "viem";
import { CubitTokenAbi, CubitV2Abi, CubitVaultAbi } from "./abi.ts";
import type { ReadContext, BlockSnapshot } from "./readContext.ts";
import type { WriteRequest } from "./writeRequest.ts";

export type VaultView = {
  vault: Address;
  current: boolean;
  totalStaked: bigint;
  rewardReserve: bigint;
  totalPaid: bigint;
  lockDuration: bigint;
  dailyRewardBps: bigint;
  rewardPeriod: bigint;
  block: BlockSnapshot;
  chainTime: bigint;
  position: null | {
    staked: bigint;
    pending: bigint;
    unlockAt: bigint;
    lastRewardAt: bigint;
    wallet: bigint;
    allowance: bigint;
  };
};

export async function readVaultAddresses({ client: publicClient, config: CONFIG }: ReadContext, block: BlockSnapshot): Promise<Address[]> {
  const count = await publicClient.readContract({ address: CONFIG.v2, abi: CubitV2Abi, functionName: "vaultCount", blockNumber: block.number });
  return Promise.all(Array.from({ length: Number(count) }, (_, i) =>
    publicClient.readContract({ address: CONFIG.v2, abi: CubitV2Abi, functionName: "vaults", args: [BigInt(i)], blockNumber: block.number })));
}

export async function readVault({ client: publicClient, config: CONFIG }: ReadContext, vault: Address, current: boolean, account: Address | null, block: BlockSnapshot, shared?: VaultView): Promise<VaultView> {
  const at = { address: vault, abi: CubitVaultAbi, blockNumber: block.number } as const;
  if (shared && (shared.vault.toLowerCase() !== vault.toLowerCase() || shared.block?.hash !== block.hash ||
      shared.block.number !== block.number || shared.block.timestamp !== block.timestamp ||
      shared.chainTime !== block.timestamp)) throw new Error("Vault snapshot changed.");
  const [totalStaked, rewardReserve, totalPaid, lockDuration, dailyRewardBps, rewardPeriod] = shared
    ? [shared.totalStaked, shared.rewardReserve, shared.totalPaid, shared.lockDuration, shared.dailyRewardBps, shared.rewardPeriod]
    : await Promise.all([
    publicClient.readContract({ ...at, functionName: "totalStaked" }),
    publicClient.readContract({ ...at, functionName: "rewardReserve" }),
    publicClient.readContract({ ...at, functionName: "totalCubitPaid" }),
    publicClient.readContract({ ...at, functionName: "LOCK_DURATION" }),
    publicClient.readContract({ ...at, functionName: "DAILY_REWARD_BPS" }),
    publicClient.readContract({ ...at, functionName: "REWARD_PERIOD" }),
  ]);
  let position: VaultView["position"] = null;
  if (account) {
    // These values extend the public snapshot. A numeric selector could silently read another branch,
    // especially when the visitor relay falls back to the public RPC. Never downgrade this selector.
    const pinned = { blockHash: block.hash, requireCanonical: true } as const;
    const personal = { address: vault, abi: CubitVaultAbi, ...pinned } as const;
    const [staked, pending, unlockAt, lastRewardAt, wallet, allowance] = await Promise.all([
      publicClient.readContract({ ...personal, functionName: "balanceOf", args: [account] }),
      publicClient.readContract({ ...personal, functionName: "pendingCubit", args: [account] }),
      publicClient.readContract({ ...personal, functionName: "unlockAt", args: [account] }),
      publicClient.readContract({ ...personal, functionName: "lastRewardAt", args: [account] }),
      publicClient.readContract({ address: CONFIG.token, abi: CubitTokenAbi, functionName: "balanceOf", args: [account], ...pinned }),
      publicClient.readContract({ address: CONFIG.token, abi: CubitTokenAbi, functionName: "allowance", args: [account, vault], ...pinned }),
    ]);
    position = { staked, pending, unlockAt, lastRewardAt, wallet, allowance };
  }
  return { vault, current, totalStaked, rewardReserve, totalPaid, lockDuration, dailyRewardBps, rewardPeriod,
    block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, chainTime: block.timestamp, position };
}

/** The newer of two readings of the same vault and account, so the page never goes back to an older block. */
export function newestVaultView(polled: VaultView | null, fresh: VaultView | null): VaultView | null {
  if (!fresh) return polled;
  if (!polled) return fresh;
  return fresh.block.number > polled.block.number ? fresh : polled;
}

/** Compound: restake what can be claimed now with one stake(amount). stake() first pays the accrued reward to the wallet,
 *  then takes `amount` back, so an empty wallet is enough; if the transaction lands later, only the extra seconds of
 *  reward stay in the wallet. Like any deposit, it restarts the 24h lock of the whole position. */
export function compoundPlan(position: VaultView["position"]): { amount: bigint; approve: boolean } | null {
  if (!position || position.pending === 0n) return null;
  return { amount: position.pending, approve: position.allowance < position.pending };
}

export const stakeRequest = (vault: Address, amount: bigint): WriteRequest => ({ address: vault, abi: CubitVaultAbi, functionName: "stake", args: [amount] });
export const withdrawRequest = (vault: Address, amount: bigint): WriteRequest => ({ address: vault, abi: CubitVaultAbi, functionName: "withdraw", args: [amount] });
export const claimRequest = (vault: Address): WriteRequest => ({ address: vault, abi: CubitVaultAbi, functionName: "claimCubit" });
