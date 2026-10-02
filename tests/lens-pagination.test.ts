import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult } from "viem";
import { mainnet } from "viem/chains";
import { CubitLensAbi } from "../src/chain/abi.ts";
import { readLens, WALL_TOTALS_PAGE_SIZE } from "../src/chain/lens.ts";
import { address, config, context, head, lensSnapshot } from "./helpers.ts";

const block = head(100), lens = address(12);

test("2501 active walls use caller pages of 500 at one canonical hash; pending inventory counts once", async () => {
  const calls: bigint[][] = [];
  let latestCount = 2501n;
  const snapshot = { ...lensSnapshot(block), activeWallCount: latestCount };
  const ctx = context({ readContract: async (request: any) => {
    assert.equal(request.address, lens);
    assert.equal(request.blockHash, block.hash);
    assert.equal(request.requireCanonical, true);
    assert.equal(request.blockNumber, undefined);
    if (request.functionName === "snapshot") return snapshot;
    assert.equal(request.functionName, "wallAmountsPage");
    calls.push(request.args);
    // The live book changes (including removal/swap-and-pop), but the pinned book stays unchanged.
    latestCount += calls.length === 1 ? 10n : -20n;
    const [start, size] = request.args;
    const next = start + size < snapshot.activeWallCount ? start + size : snapshot.activeWallCount;
    return [(next - start) * 2n, (next - start) * 3n, next, snapshot.activeWallCount];
  } });
  const result = await readLens(ctx, lens, block);
  assert.equal(WALL_TOTALS_PAGE_SIZE, 500n);
  assert.deepEqual(calls, [[0n, 500n], [500n, 500n], [1000n, 500n], [1500n, 500n], [2000n, 500n], [2500n, 500n]]);
  assert.equal(result.wallEth, 5002n);
  assert.equal(result.wallTokens, 7503n + snapshot.pendingAbsorbedTokens);
  assert.equal(result.circulatingSupply, snapshot.totalSupply - result.wallTokens - snapshot.rewardReserve);
  assert.equal(result.heldSupply, result.circulatingSupply - snapshot.bandTokens);
});

test("page policy is configurable without changing the ABI, and accumulators do not survive refreshes", async () => {
  const starts: bigint[] = [];
  const ctx = context({ readContract: async ({ functionName, args }: any) => {
    if (functionName === "snapshot") return { ...lensSnapshot(block), activeWallCount: 3n };
    const [start, size] = args;
    starts.push(start);
    const next = start + size < 3n ? start + size : 3n;
    return [next - start, next - start, next, 3n];
  } });
  const small = await readLens(ctx, lens, block, 1n);
  assert.deepEqual(starts, [0n, 1n, 2n]);
  starts.length = 0;
  assert.deepEqual(await readLens(ctx, lens, block, 2000n), small);
  assert.deepEqual(starts, [0n]);
  for (const size of [0n, -1n, 1n << 256n]) await assert.rejects(readLens(ctx, lens, block, size), /page size/);
});

test("empty wall books still exclude pending tokens once, and both supply deductions saturate at zero", async () => {
  let raw = { ...lensSnapshot(block), totalSupply: 10n, pendingAbsorbedTokens: 3n, rewardReserve: 5n, bandTokens: 4n };
  let reads = 0;
  const ctx = context({ readContract: async ({ functionName }: any) => {
    assert.equal(functionName, "snapshot"); reads++; return raw;
  } });
  const result = await readLens(ctx, lens, block);
  assert.equal(reads, 1);
  assert.equal(result.wallEth, 0n);
  assert.equal(result.wallTokens, 3n);
  assert.equal(result.circulatingSupply, 2n);
  assert.equal(result.heldSupply, 0n);
  raw = { ...raw, rewardReserve: 10n };
  assert.equal((await readLens(ctx, lens, block)).circulatingSupply, 0n);
});

test("failed, inconsistent or non-advancing pages reject the entire read", async () => {
  for (const bad of [null, [0n, 0n, 1000n, 2001n], [0n, 0n, 1000n, 2000n], [0n, 0n, 2001n, 2001n]]) {
    const ctx = context({ readContract: async ({ functionName, args }: any) => {
      if (functionName === "snapshot") return { ...lensSnapshot(block), activeWallCount: 2001n };
      if (args[0] === 0n) return [5n, 7n, 500n, 2001n];
      if (bad === null) throw new Error("RPC page unavailable");
      return bad;
    } });
    await assert.rejects(readLens(ctx, lens, block), /page/);
  }
});

test("wrong block, unsupported hash selector and a reorg during pagination fail without latest fallback", async () => {
  await assert.rejects(readLens(context({ readContract: async () => lensSnapshot(head(99)) }), lens, block), /another block/);
  let reads = 0;
  const ctx = context({ readContract: async ({ blockHash, requireCanonical, functionName, args }: any) => {
    reads++;
    assert.equal(blockHash, block.hash); assert.equal(requireCanonical, true);
    if (functionName === "snapshot") return { ...lensSnapshot(block), activeWallCount: 2001n };
    if (args[0] === 0n) return [5n, 7n, 500n, 2001n];
    throw new Error("Block is no longer canonical");
  } });
  await assert.rejects(readLens(ctx, lens, block), /canonical/);
  assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(readLens(context({ readContract: async () => {
    reads++; throw new Error("Hash selector unsupported");
  } }), lens, block), /unsupported/);
  assert.equal(reads, 1);
});

test("real viem transport emits separate EIP-1898 eth_calls, even with automatic multicall enabled", async () => {
  const requests: any[] = [];
  const raw = { ...lensSnapshot(block), activeWallCount: 3000n };
  const client = createPublicClient({ chain: mainnet, batch: { multicall: { wait: 1 } }, transport: custom({
    async request(request) {
      requests.push(request);
      assert.equal(request.method, "eth_call");
      const [tx, selector] = request.params as any;
      assert.equal(tx.to.toLowerCase(), lens.toLowerCase());
      assert.deepEqual(selector, { blockHash: block.hash, requireCanonical: true });
      const decoded = decodeFunctionData({ abi: CubitLensAbi, data: tx.data });
      if (decoded.functionName === "snapshot")
        return encodeFunctionResult({ abi: CubitLensAbi, functionName: "snapshot", result: raw });
      assert.equal(decoded.functionName, "wallAmountsPage");
      const [start, size] = decoded.args as readonly [bigint, bigint];
      return encodeFunctionResult({ abi: CubitLensAbi, functionName: "wallAmountsPage", result: [1n, 2n, start + size, 3000n] });
    },
  }, { retryCount: 0 }) });
  const result = await readLens({ client, config }, lens, block);
  assert.equal(requests.length, 7);
  assert.equal(result.wallEth, 6n);
  assert.equal(result.wallTokens, 12n + raw.pendingAbsorbedTokens);
});
