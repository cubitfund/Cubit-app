import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroAddress, toHex } from "viem";
import { PublicData } from "../src/chain/publicData.ts";
import { SCHEMA_VERSION, SNAPSHOT_WARNING_MS, SnapshotClient, stringifyData, type DataSnapshot } from "../src/chain/snapshot.ts";
import { cubitMarket, MarketClosedError, readMarket } from "../src/chain/market.ts";
import { BlockClock } from "../src/chain/blockClock.ts";
import { PollTask } from "../src/chain/pollTask.ts";
import { sqrtPriceAtTick } from "../src/chain/math.ts";
import { address, config, context, flush, head, lensSnapshot } from "./helpers.ts";

function fixture() {
  const calls: string[] = [];
  let open = false, failed = false, block = head(100);
  const sqrt = sqrtPriceAtTick(150_000);
  const ctx = context({
    getBlock: async () => block,
    readContract: async ({ functionName, blockNumber, blockHash }: { functionName: string; blockNumber?: bigint; blockHash?: string }) => {
      calls.push(functionName);
      if (blockHash) assert.equal(blockHash, block.hash); else assert.equal(blockNumber, block.number);
      if (failed) throw new Error("RPC unavailable");
      const values: Record<string, unknown> = {
        extsload: toHex(open ? sqrt | 150_000n << 160n : 0n, { size: 32 }),
        vault: address(10), router: address(11), lens: address(12), forge: zeroAddress,
        enabledFeatures: 0n, moduleRevision: 0n, vaultCount: 1n,
      };
      if (functionName in values) return values[functionName];
      assert.ok(open, `Closed market must not read ${functionName}`);
      const market: Record<string, unknown> = {
        band: [140_000, 160_000, 10n], pendingFloorEth: 0n, pendingAbsorbedTokens: 0n, wallCount: 0n,
        teamAccrued: 0n, teamPaidCumulative: 0n, INITIAL_SQRT_PRICE: sqrt, TEAM_ADDRESS: address(8), absorbedTokenSink: address(9),
        totalSupply: 21_000_000n, totalBurned: 0n, snapshot: { ...lensSnapshot(block), pendingAbsorbedTokens: 0n },
        totalStaked: 0n, rewardReserve: 0n, totalCubitPaid: 0n,
      };
      assert.ok(functionName in market, functionName); return market[functionName];
    },
    getLogs: () => assert.fail("Closed market must not read history"),
    multicall: () => assert.fail("There are no walls"),
  });
  const data = new PublicData(ctx, ctx, null);
  return { ctx, data, calls, setOpen: (value = true) => { open = value; }, fail: () => { failed = true; },
    advance: (number = Number(block.number) + 1) => { block = head(number); } };
}

for (const state of ["closed", "unavailable", "stale"]) test(`a closed market uses direct reads while the Worker is ${state}, then returns to shared data`, async () => {
  const f = fixture();
  let now = 1_200_000, published: DataSnapshot | null = null;
  const publish = async () => {
    const block = await f.ctx.client.getBlock({ blockTag: "latest" });
    const market = await readMarket(f.ctx, cubitMarket(config), block);
    return { schemaVersion: SCHEMA_VERSION, chainId: 1, block, producedAt: now,
      market, registry: market.registry!, children: [], markets: {}, histories: {}, eventTimes: {},
      vaults: [], forge: null, governance: null } satisfies DataSnapshot;
  };
  if (state === "stale") { f.setOpen(); published = { ...await publish(), producedAt: now - 60_001 }; f.setOpen(false); }
  const client = new SnapshotClient("https://data.invalid", async (url) => {
    assert.equal(url, "https://data.invalid/data/mainnet/latest.json");
    return published ? new Response(stringifyData(published)) : Response.json(state === "closed"
      ? { code: "MARKET_CLOSED", error: "The CUBIT market is not open yet." }
      : { error: "Public snapshot unavailable." }, { status: 503 });
  });
  const visitor = context({ readContract: () => assert.fail("Public fallback must not use the relay") });
  const data = new PublicData(f.ctx, visitor, client, () => now);
  const warnings: (string | null)[] = [];
  const stop = data.subscribe(() => warnings.push(data.warning));
  for (const elapsed of [0, 30_000, SNAPSHOT_WARNING_MS, SNAPSHOT_WARNING_MS + 1, 3_600_000, 14_400_000]) {
    now = 1_200_000 + elapsed; f.advance(Math.floor(now / 12_000)); f.calls.length = 0;
    const block = await data.readHead();
    assert.equal(block.source, "direct");
    const view = await data.protocol(block, true);
    assert.equal(view.marketOpen, false);
    assert.equal(view.market, null);
    assert.equal(view.registry.flags, 0);
    assert.equal(view.registry.forge, zeroAddress);
    assert.equal(f.calls.length, 8, "closed reads stop at the pool and registry");
    if (state === "closed" || elapsed <= SNAPSHOT_WARNING_MS) assert.equal(data.warning, null);
    else assert.match(data.warning!, /Using the public RPC/);
  }
  if (state === "closed") {
    assert.equal(client.error, null);
    assert.ok(warnings.every((warning) => warning === null), "subscribers never see a source warning");
  }
  f.setOpen(); f.advance(); published = await publish(); f.calls.length = 0;
  const block = await data.readHead();
  assert.equal(block.source, "shared");
  assert.equal((await data.protocol(block, true)).marketOpen, true);
  assert.equal(data.warning, null);
  assert.equal(client.error, null);
  assert.deepEqual(f.calls, [], "the first fresh publication resumes shared reads");
  stop();
});

test("closed responses clear pending and visible degradation; each later outage gets five continuous minutes", async () => {
  const f = fixture(); let now = 0, closed = true, attempt = 0;
  const client = new SnapshotClient("https://data.invalid", async () => {
    if (closed) return Response.json({ code: "MARKET_CLOSED" }, { status: 503 });
    switch (attempt++ % 3) {
      case 0: throw new TypeError("Network error");
      case 1: return new Response(null, { status: 500 });
      default: return new Response("unreadable", { status: 503 });
    }
  });
  const data = new PublicData(f.ctx, f.ctx, client, () => now);
  const warnings: (string | null)[] = [];
  const stop = data.subscribe(() => warnings.push(data.warning));
  const read = async () => {
    const block = await data.readHead();
    assert.equal(block.source, "direct");
    assert.equal((await data.protocol(block, false)).marketOpen, false, "direct reads continue throughout");
  };
  for (const recoverEarly of [true, false, false]) {
    now += 14_400_000;
    await read(); assert.equal(data.warning, null); assert.equal(client.error, null);
    closed = false;
    const start = ++now;
    for (const elapsed of [0, 60_000, SNAPSHOT_WARNING_MS - 1]) {
      now = start + elapsed;
      await read(); assert.equal(data.warning, null);
    }
    if (!recoverEarly) {
      now = start + SNAPSHOT_WARNING_MS;
      await read(); assert.equal(data.warning, null);
      now++;
      await read(); assert.match(data.warning!, /Shared data unavailable/);
    }
    closed = true; now++;
    await read();
    assert.equal(data.warning, null);
    assert.equal(client.error, null);
    assert.equal(warnings.at(-1), null, "recovery is immediately visible to subscribers");
  }
  assert.equal(warnings.filter((warning) => warning !== null).length, 2);
  stop();
});

for (const full of [true, false]) test(`closed market ${full ? "page" : "header"} reads preserve registry flags without calling the Lens`, async () => {
  const f = fixture();
  const block = await f.data.readHead();
  assert.equal(block.source, "direct");
  const view = await f.data.protocol(block, full);
  assert.equal(view.marketOpen, false);
  assert.equal(view.market, null);
  assert.equal(view.registry.flags, 0);
  assert.equal(view.registry.forge, zeroAddress);
  assert.equal(view.registry.vault, address(10));
  assert.equal(f.calls.length, 8);
  assert.equal(f.data.warning, null);
  await f.data.assertBlock(block);
  f.fail();
  await assert.rejects(f.data.protocol(block, full), /RPC unavailable/, "an outage must never be classified as closed");
});

test("a direct market read stops at the uninitialized pool before other contract reads", async () => {
  const f = fixture();
  await assert.rejects(readMarket(f.ctx, cubitMarket(config), head(100)), MarketClosedError);
  assert.deepEqual(f.calls, ["extsload"]);
});

test("the same app detects launch without a build or feature activation", async () => {
  const f = fixture();
  assert.equal((await f.data.protocol(head(100), true)).marketOpen, false);
  f.setOpen(); f.advance(); f.calls.length = 0;
  const view = await f.data.protocol(await f.data.readHead(), true);
  assert.equal(view.marketOpen, true);
  assert.equal(view.registry.flags, 0, "feature activation is independent of pool initialization");
  assert.equal(view.market?.block, 101n);
  assert.ok(f.calls.includes("snapshot"));
  assert.equal(f.calls.filter((c) => c === "extsload").length, 1);
  assert.equal(f.calls.filter((c) => c === "enabledFeatures").length, 1);
});

test("closed polling is paced, coalesced and silent, and pauses in a hidden tab", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture();
  let now = 0, published = 0;
  const clock = new BlockClock(f.data.readHead);
  const poll = new PollTask({ clock, interval: 30_000, now: () => now, allowed: () => true,
    load: (block) => f.data.protocol(block, true), publish: (view) => { assert.equal(view.marketOpen, false); published++; },
    error: () => assert.fail("A closed market is not a read failure"),
  });
  try {
    poll.start(); await flush();
    assert.equal(published, 1);
    await Promise.all([clock.refresh(), clock.refresh(), clock.refresh()]); await flush();
    assert.equal(published, 1);
    for (let i = 0; i < 3; i++) {
      now += 10_000; f.advance(); await clock.refresh(); await flush();
    }
    assert.equal(published, 2);
    assert.equal(f.calls.length, 16);
    clock.setVisible(false);
    now += 60_000; t.mock.timers.tick(60_000); await flush();
    assert.equal(published, 2);
  } finally { poll.stop(); }
});
