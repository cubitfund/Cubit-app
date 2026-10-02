import assert from "node:assert/strict";
import { test } from "node:test";
import { readMarket, cubitMarket } from "../src/chain/market.ts";
import { readVault, readVaultAddresses } from "../src/chain/vault.ts";
import { assertBlock } from "../src/chain/readContext.ts";
import { address, config, context, head, lensSnapshot } from "./helpers.ts";
import { sqrtPriceAtTick } from "../src/chain/math.ts";
import { readGovernance } from "../src/chain/launchpad.ts";

test("market reads, wall pages, Lens and vault use the supplied block without detecting another head", async () => {
  const block = head(100);
  const sqrt = sqrtPriceAtTick(150_000);
  const word = `0x${(sqrt | (150_000n << 160n)).toString(16).padStart(64, "0")}`;
  let reads = 0;
  const ctx = context({
    readContract: async ({ functionName, blockNumber, blockHash, requireCanonical }: { functionName: string; blockNumber?: bigint; blockHash?: string; requireCanonical?: boolean }) => {
      if (blockHash) { assert.equal(blockHash, block.hash); assert.equal(requireCanonical, true); }
      else assert.equal(blockNumber, 100n);
      reads++;
      const values: Record<string, unknown> = {
        extsload: word, band: [140_000, 160_000, 10n], pendingFloorEth: 0n, pendingAbsorbedTokens: 0n, wallCount: 1n,
        teamAccrued: 0n, teamPaidCumulative: 0n, INITIAL_SQRT_PRICE: sqrt, TEAM_ADDRESS: address(8), absorbedTokenSink: address(9),
        totalSupply: 21_000_000n, totalBurned: 0n, vault: address(10), router: address(11), lens: address(12), forge: address(13), enabledFeatures: 13n,
        moduleRevision: 1n, vaultCount: 1n, snapshot: { ...lensSnapshot(block), pendingAbsorbedTokens: 0n }, totalStaked: 0n, rewardReserve: 0n, totalCubitPaid: 0n,
      };
      assert.ok(functionName in values, functionName); return values[functionName];
    },
    multicall: async ({ blockNumber }: { blockNumber: bigint }) => { assert.equal(blockNumber, 100n); return [[151_000, 0n, 0n, 0n]]; },
    getBlock: async () => { throw new Error("reader must use the clock's block"); },
  });
  const state = await readMarket(ctx, cubitMarket(config), block);
  assert.equal(state.block, 100n);
  assert.equal(state.blockHash, block.hash);
  assert.ok(reads > 15);
});

test("staking vault totals, position and address list are pinned to the supplied block", async () => {
  const ctx = context({ readContract: async ({ functionName, blockNumber, blockHash, requireCanonical }: { functionName: string; blockNumber?: bigint; blockHash?: string; requireCanonical?: boolean }) => {
    if (["balanceOf", "pendingCubit", "unlockAt", "lastRewardAt", "allowance"].includes(functionName)) {
      assert.equal(blockHash, head(100).hash);
      assert.equal(requireCanonical, true);
      assert.equal(blockNumber, undefined);
    } else assert.equal(blockNumber, 100n);
    return functionName === "vaults" ? address(10) : 1n;
  } });
  const vault = await readVault(ctx, address(10), true, address(20), head(100));
  assert.equal(vault.position?.wallet, 1n);
  assert.equal(vault.chainTime, head(100).timestamp);
  assert.deepEqual(vault.block, head(100));
  assert.deepEqual(await readVaultAddresses(ctx, head(100)), [address(10)]);
});

test("snapshot validation rejects provider disagreement or reorg at the selected block", async () => {
  const ctx = context({ getBlock: async () => head(100, 1) });
  await assert.rejects(assertBlock(ctx, head(100)), /changed/);
});

test("shared vault totals cause no public rereads; only the visitor position reads through RPC", async () => {
  const block = head(100);
  let calls: string[] = [];
  const ctx = context({ readContract: async ({ functionName }: { functionName: string }) => { calls.push(functionName); return 1n; } });
  const shared = await readVault(ctx, address(10), true, null, block);
  calls = [];
  assert.deepEqual(await readVault(ctx, address(10), true, null, block, shared), shared);
  assert.equal(calls.length, 0);
  const own = await readVault(ctx, address(10), true, address(30), block, shared);
  assert.equal(calls.length, 6); assert.equal(own.position?.staked, 1n);
  await assert.rejects(readVault(ctx, address(11), true, null, block, shared), /changed/);
});

test("governance shared totals require no RPC for visitors, and owners only read their tranche details", async () => {
  const block = head(100), owner = address(30);
  let calls: string[] = [];
  const ctx = context({ readContract: async ({ functionName }: { functionName: string }) => {
    calls.push(functionName);
    return functionName === "deployer" ? owner : 0n;
  } });
  const shared = await readGovernance(ctx, address(10), [{ token: address(1), symbol: "TEST" }], block);
  calls = [];
  const visitor = await readGovernance(ctx, address(10), [], block, null, {}, shared);
  assert.equal(visitor.assets.length, 1); assert.equal(calls.length, 0);
  await readGovernance(ctx, address(10), [], block, owner, {}, shared);
  assert.deepEqual(calls, [], "the owner does not trigger automatic detail reads");
  await readGovernance(ctx, address(10), [], block, owner, { ["0x" + "0".repeat(40)]: null }, shared);
  assert.deepEqual(calls.sort(), ["nextTranche", "nextTranche", "trancheCount", "trancheCount"]);
});
