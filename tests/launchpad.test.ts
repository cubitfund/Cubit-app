import assert from "node:assert/strict";
import { test } from "node:test";
import { createLaunchpadReader, readForge, readGovernance, linkedHookCreationCode } from "../src/chain/launchpad.ts";
import { launchpadPage } from "../src/chain/launchpadPage.ts";
import { createMetadataCache } from "../src/chain/tokenMetadata.ts";
import { address, config, context, deferred, hash, head } from "./helpers.ts";
import { zeroAddress, keccak256 } from "viem";

test("metadata coalesces, keys by network and address, and retries failures", async () => {
  const cache = createMetadataCache();
  const pending = deferred<{ name: string; symbol: string }>();
  let calls = 0;
  const load = () => { calls++; return pending.promise; };
  const one = cache.read(1, address(10), load);
  const two = cache.read(1, address(10).toUpperCase() as `0x${string}`, load);
  assert.equal(one, two);
  pending.resolve({ name: "Name", symbol: "SYM" });
  await one;
  await cache.read(1, address(10), load);
  assert.equal(calls, 1);
  await cache.read(2, address(10), load);
  assert.equal(calls, 2);
  cache.forget(1, address(10));
  await assert.rejects(cache.read(1, address(10), async () => { throw new Error("temporary"); }));
  assert.deepEqual(await cache.read(1, address(10), load), { name: "Name", symbol: "SYM" });
  assert.equal(calls, 3);
});

test("launched token and registry cursors survive upgrades, reread only recent blocks and remove reorged launches", async () => {
  let branchFrom = Infinity;
  let names = 0;
  const ranges: { event: string; forge: string; from: bigint; to: bigint }[] = [];
  const log = (block: number, args: object, index = 0) => ({ blockNumber: BigInt(block), blockHash: hash(block), transactionHash: hash(block + 500), logIndex: index, args });
  const registrations = [log(3, { previous: zeroAddress, current: config.forge }), log(15, { previous: config.forge, current: address(6) })];
  let launches = [log(10, { token: address(20), hook: address(21), launcher: address(22), team: address(23), fee: 1n }), log(19, { token: address(30), hook: address(31), launcher: address(22), team: address(23), fee: 1n })];
  const ctx = context({
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: hash(Number(blockNumber), Number(blockNumber) >= branchFrom ? 1 : 0) }),
    getContractEvents: async ({ eventName, address: forge, fromBlock, toBlock }: { eventName: string; address: string; fromBlock: bigint; toBlock: bigint }) => {
      ranges.push({ event: eventName, forge, from: fromBlock, to: toBlock });
      return (eventName === "ModuleUpdated" ? registrations : launches.filter((l) => (l.blockNumber < 15n ? config.forge : address(6)) === forge)).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => { names++; assert.ok(blockNumber >= 20n); return functionName === "name" ? "Name" : "SYM"; },
  });
  const read = createLaunchpadReader(ctx);
  assert.equal((await read(head(20))).length, 2);
  assert.equal(names, 4);
  await read(head(22));
  assert.equal(names, 4);
  assert.ok(ranges.slice(3).every((r) => r.from === 15n));
  launches = launches.slice(0, 1); branchFrom = 19;
  const after = await read(head(23, 1));
  assert.deepEqual(after.map((c) => c.token), [address(20)]);
  assert.equal(names, 4, "stable metadata is never reread");
});

function governanceClient(owner: string) {
  const calls: { functionName: string; args?: readonly unknown[]; blockHash: string; requireCanonical: boolean; blockNumber?: bigint }[] = [];
  const ctx = context({ readContract: async (call: typeof calls[number]) => {
    calls.push(call);
    assert.equal(call.blockHash, head(100).hash);
    assert.equal(call.requireCanonical, true);
    assert.equal(call.blockNumber, undefined);
    const fixed: Record<string, unknown> = { deployer: owner, LOCK_DURATION: 1_000n, lockExtension: 0n, held: 100n, trancheCount: 100n, nextTranche: 0n };
    if (call.functionName !== "tranche") {
      assert.ok(call.functionName in fixed, `Unexpected read: ${call.functionName}`);
      return fixed[call.functionName];
    }
    const index = call.args![1] as bigint;
    return [1n, index < 85n ? 100n : 2_000n];
  } });
  return { ctx, calls };
}

test("governance totals are public but tranche details are never read for visitors", async () => {
  const { ctx, calls } = governanceClient(address(7));
  const view = await readGovernance(ctx, address(8), [], head(100), address(9));
  assert.equal(view.assets[0].held, 100n);
  assert.equal(view.assets[0].details, null);
  assert.equal(view.assets[0].detailError, null);
  assert.ok(!calls.some((c) => ["locked", "claimable", "tranche", "nextTranche", "trancheCount"].includes(c.functionName)));
});

test("governance owner gets paginated tranches and the real next lock beyond the visible page", async () => {
  const { ctx } = governanceClient(address(7));
  const first = (await readGovernance(ctx, address(8), [], head(100), address(7), { [zeroAddress]: 0 })).assets[0].details!;
  assert.equal(first.tranches.length, 40);
  assert.ok(first.tranches.every((t) => t.unlockAt < head(100).timestamp));
  assert.equal(first.nextLocked?.index, 85n);
  assert.equal(first.locked, 15n);
  const last = (await readGovernance(ctx, address(8), [], head(100), address(7), { [zeroAddress]: 2 })).assets[0].details!;
  assert.equal(last.tranches.length, 20);
  assert.equal(last.tranches[0].index, 80n);
});

test("Forge reads and constructor templates use only the injected context and snapshot", async () => {
  const codeHash = keccak256(linkedHookCreationCode(config));
  const calls: bigint[] = [];
  const ctx = context({ readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
    calls.push(blockNumber);
    return ({ launchFee: 1n, launches: 2n, governanceVault: address(8), hookCreationCodeHash: codeHash, LAUNCH_ETH: 3n, poolManager: config.poolManager } as Record<string, unknown>)[functionName];
  } });
  const forge = await readForge(ctx, config.forge, head(100));
  assert.equal(forge.templateMatches, true);
  assert.deepEqual(calls, Array(6).fill(100n));
});


test("governance reads ETH and only the current launch page, with a bounded call count", async () => {
  const tokens = Array.from({ length: 100 }, (_, i) => ({ token: address(i + 100), symbol: `T${i}` }));
  const calls: { functionName: string; args?: readonly unknown[]; blockHash: string; requireCanonical: boolean; blockNumber?: bigint }[] = [];
  const ctx = context({ readContract: async (call: typeof calls[number]) => {
    calls.push(call);
    assert.equal(call.blockHash, head(100).hash);
    assert.equal(call.requireCanonical, true);
    assert.equal(call.blockNumber, undefined);
    if (call.functionName === "deployer") return address(7);
    if (call.functionName === "LOCK_DURATION") return 1_000n;
    if (call.functionName === "lockExtension") return 0n;
    const token = call.args![0] as string;
    const held = token === zeroAddress ? 123_456n : BigInt(token);
    if (call.functionName === "held") return held;
    throw new Error(`Unexpected detail read: ${call.functionName}`);
  } });
  for (const [requestedPage, expected] of [
    [0, tokens.slice(88).reverse()],
    [1, tokens.slice(76, 88).reverse()],
    [8, tokens.slice(0, 4).reverse()],
  ] as const) {
    calls.length = 0;
    const page = launchpadPage(tokens, requestedPage);
    assert.equal(page.pageCount, 9);
    assert.deepEqual(page.tokens, expected);
    const view = await readGovernance(ctx, address(8), page.tokens, head(100));
    assert.deepEqual(view.assets.map((a) => a.token), [zeroAddress, ...expected.map((t) => t.token)]);
    assert.deepEqual(view.assets.map((a) => a.symbol), ["ETH", ...expected.map((t) => t.symbol)]);
    assert.equal(view.assets[0].held, 123_456n, "the fees total is independent of the token page");
    for (const asset of view.assets.slice(1)) assert.equal(asset.held, BigInt(asset.token));
    assert.equal(calls.length, 3 + expected.length + 1); // 16 at most, including three vault-wide reads.
    assert.deepEqual(new Set(calls.flatMap((c) => c.args?.length ? [c.args[0]] : [])), new Set(view.assets.map((a) => a.token)));
  }
  calls.length = 0;
  const empty = await readGovernance(ctx, address(8), launchpadPage([], 0).tokens, head(100));
  assert.deepEqual(empty.assets.map((a) => a.token), [zeroAddress]);
  assert.equal(empty.assets[0].held, 123_456n);
  assert.equal(calls.length, 4);
});
