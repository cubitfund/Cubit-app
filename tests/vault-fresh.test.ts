import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicData } from "../src/chain/publicData.ts";
import { newestVaultView, type VaultView } from "../src/chain/vault.ts";
import { address, context, head } from "./helpers.ts";

const vault = address(10), account = address(40);

test("after a transaction the vault is read at the receipt's block through the direct RPC, never the relay", async () => {
  const receiptBlock = head(120);
  const calls: string[] = [];
  const values: Record<string, bigint> = {
    totalStaked: 141n, rewardReserve: 5n, totalCubitPaid: 6n, LOCK_DURATION: 86_400n, DAILY_REWARD_BPS: 300n,
    REWARD_PERIOD: 86_400n, balanceOf: 41n, pendingCubit: 1n, unlockAt: 2n, lastRewardAt: 3n, allowance: 4n,
  };
  const direct = context({
    getBlock: async ({ blockHash }: { blockHash?: string }) => {
      assert.equal(blockHash, receiptBlock.hash); calls.push("block"); return receiptBlock;
    },
    readContract: async ({ functionName, blockNumber, blockHash, requireCanonical }:
      { functionName: string; blockNumber?: bigint; blockHash?: string; requireCanonical?: boolean }) => {
      if (blockHash) { assert.equal(blockHash, receiptBlock.hash); assert.equal(requireCanonical, true); }
      else assert.equal(blockNumber, receiptBlock.number);
      calls.push(functionName);
      return values[functionName];
    },
  });
  const visitor = context({
    getBlock: () => assert.fail("a fresh position must not go through the relay"),
    readContract: () => assert.fail("a fresh position must not go through the relay"),
  });
  const snapshots = { refresh: () => assert.fail("a fresh position does not wait for the shared snapshot") };
  const data = new PublicData(direct, visitor, snapshots as never);
  const view = await data.vaultAt(vault, true, account, { blockHash: receiptBlock.hash });
  assert.equal(calls[0], "block");
  assert.deepEqual(view.block, receiptBlock);
  assert.equal(view.chainTime, receiptBlock.timestamp);
  assert.equal(view.totalStaked, 141n);
  assert.equal(view.position?.staked, 41n);
  assert.equal(view.position?.allowance, 4n);
});

test("the page keeps the newer reading: the fresh one until the snapshot reaches its block", () => {
  const at = (n: number, staked: bigint): VaultView => ({
    vault, current: true, totalStaked: staked, rewardReserve: 5n, totalPaid: 0n, lockDuration: 86_400n,
    dailyRewardBps: 300n, rewardPeriod: 86_400n, block: head(n), chainTime: head(n).timestamp,
    position: { staked, pending: 0n, unlockAt: 0n, lastRewardAt: 0n, wallet: 0n, allowance: 0n },
  });
  assert.equal(newestVaultView(at(100, 1n), at(110, 41n))?.position?.staked, 41n, "an older snapshot never hides the stake");
  assert.equal(newestVaultView(at(110, 41n), at(110, 41n))?.block.number, 110n);
  assert.equal(newestVaultView(at(112, 41n), at(110, 41n))?.block.number, 112n, "the snapshot takes over once it catches up");
  assert.equal(newestVaultView(null, at(110, 41n))?.block.number, 110n);
  assert.equal(newestVaultView(at(100, 1n), null)?.block.number, 100n);
  assert.equal(newestVaultView(null, null), null);
});
