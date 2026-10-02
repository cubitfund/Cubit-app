import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroAddress } from "viem";
import { GovernanceDetail } from "../src/chain/governanceDetail.ts";
import { readGovernance, type GovernanceView } from "../src/chain/launchpad.ts";
import { readGovernanceDetails, type GovernanceDetails } from "../src/chain/tranches.ts";
import { BlockClock } from "../src/chain/blockClock.ts";
import { PollTask } from "../src/chain/pollTask.ts";
import { address, context, deferred, flush, head } from "./helpers.ts";

test("24 hours of owner polling with 13 assets and new blocks never rereads explicitly loaded details", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const vault = address(8), owner = address(7), tokens = Array.from({ length: 12 }, (_, i) => ({ token: address(100 + i), symbol: `T${i}` }));
  let block = head(100), reads = 0, requests = 0, publications = 0;
  const originalBlock = block;
  const ctx = context({ readContract: async (call: any) => {
    reads++;
    assert.equal(call.blockHash, block.hash); assert.equal(call.requireCanonical, true);
    const values: Record<string, unknown> = { deployer: owner, LOCK_DURATION: 2_592_000n, lockExtension: 0n,
      held: 20_000n, trancheCount: 20_000n, nextTranche: 0n, tranche: [1n, originalBlock.timestamp + 2_592_000n] };
    assert.ok(call.functionName in values); return values[call.functionName];
  } });
  const initial = await readGovernance(ctx, vault, tokens, block);
  let view = initial;
  reads = 0;
  const detail = new GovernanceDetail(async (v, token, held, page, signal) => {
    requests++;
    return readGovernanceDetails(ctx, v.vault, token, held, v.block, page, signal);
  });
  const clock = new BlockClock(async () => block);
  const task = new PollTask({ clock, interval: 15_000, allowed: () => true,
    load: (b) => readGovernance(ctx, vault, tokens, b, owner, {}, { ...initial, block: b }),
    publish: (v) => { view = v; publications++; }, error: assert.fail });
  t.after(() => { task.stop(); detail.invalidate(); });
  task.start(); await clock.refresh(); await flush();
  assert.equal(reads, 0, "even the owner initially loads public totals only");
  for (const asset of view.assets) await detail.request(view, asset.token);
  assert.equal(requests, 13); assert.equal(reads, 65);
  const cached = detail.snapshot();
  for (let step = 1; step <= 5_760; step++) {
    block = head(100 + Math.floor(step * 15 / 12));
    t.mock.timers.tick(15_000);
    await clock.refresh(); await flush();
  }
  assert.ok(publications >= 5_760, "exercise the actual public polling lifecycle across new blocks");
  assert.equal(requests, 13); assert.equal(reads, 65);
  assert.equal(detail.snapshot(), cached, "public polling never changes the dated observations");
  assert.ok([...cached.values()].every((s) => s.block.hash === originalBlock.hash && s.held === 20_000n));
  assert.notEqual(view.block.hash, originalBlock.hash);
  t.diagnostic("13 assets × 20000 locked rows, opened once: 65 detail calls / 1300 credits in 24 h; subsequent blocks: 0 detail calls");

  // The UI uses this same invalidation after a governance transaction attempt or identity cleanup.
  detail.invalidate();
  assert.equal(detail.snapshot().size, 0);
  t.mock.timers.tick(15_000); await clock.refresh(); await flush();
  assert.equal(reads, 65, "invalidation does not start an automatic request storm");
  await detail.request(view, zeroAddress);
  assert.equal(reads, 70); assert.equal(detail.snapshot().get(zeroAddress)!.block.hash, view.block.hash);
});

const totals = (number = 100): GovernanceView => ({ vault: address(8), deployer: address(7), lockDuration: 2_592_000n, lockExtension: 0n,
  block: head(number), assets: [zeroAddress, address(10)].map((token) => ({ token, symbol: "TEST", held: 2n, details: null, detailError: null })) });
const result = (amount = 1n): GovernanceDetails => ({ locked: 2n - amount, claimable: amount, claimableTranches: 1n,
  tranches: [], nextLocked: null, trancheCount: 2n, nextTranche: 0n, page: 0 });

test("superseded requests, transaction invalidation and unmount cannot publish a late response", async () => {
  const pending = [deferred<GovernanceDetails>(), deferred<GovernanceDetails>(), deferred<GovernanceDetails>()];
  const signals: AbortSignal[] = [];
  const detail = new GovernanceDetail(async (_view, _token, _held, _page, signal) => {
    signals.push(signal); return pending[signals.length - 1].promise;
  });
  const old = detail.request(totals(), zeroAddress);
  const fresh = detail.request(totals(101), zeroAddress);
  assert.equal(signals[0].aborted, true);
  pending[1].resolve(result(2n)); await fresh;
  pending[0].resolve(result(1n)); await old;
  assert.equal(detail.snapshot().get(zeroAddress)!.details!.claimable, 2n);
  assert.equal(detail.snapshot().get(zeroAddress)!.block.hash, head(101).hash);
  const disposed = detail.request(totals(102), zeroAddress);
  detail.invalidate(); assert.equal(signals[2].aborted, true);
  pending[2].resolve(result()); await disposed;
  assert.equal(detail.snapshot().size, 0);
});

test("a detail failure replaces only that asset's result, preserves its dated held and never touches public totals", async () => {
  let fail = false;
  const detail = new GovernanceDetail(async (_view, token) => {
    if (fail && token === zeroAddress) throw new Error("provider refused");
    return result();
  });
  const view = totals(), before = structuredClone(view);
  await detail.request(view, zeroAddress); await detail.request(view, address(10));
  const other = detail.snapshot().get(address(10));
  fail = true; await detail.request(totals(101), zeroAddress);
  const eth = detail.snapshot().get(zeroAddress)!;
  assert.equal(eth.details, null); assert.match(eth.error!, /Detail unavailable/);
  assert.equal(eth.held, 2n); assert.equal(eth.block.hash, head(101).hash);
  assert.equal(detail.snapshot().get(address(10)), other);
  assert.deepEqual(view, before);
});
