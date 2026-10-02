import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 } from "viem";
import { PublicData } from "../src/chain/publicData.ts";
import { SCHEMA_VERSION, SNAPSHOT_WARNING_MS, SnapshotClient, stringifyData, type DataSnapshot } from "../src/chain/snapshot.ts";
import { BlockClock } from "../src/chain/blockClock.ts";
import { PollTask } from "../src/chain/pollTask.ts";
import { cubitMarket, readMarket } from "../src/chain/market.ts";
import { readForge, readGovernance, linkedHookCreationCode } from "../src/chain/launchpad.ts";
import { readVault } from "../src/chain/vault.ts";
import { sqrtPriceAtTick } from "../src/chain/math.ts";
import { address, config, context, deferred, flush, head, lensSnapshot } from "./helpers.ts";

async function fixture(number = 100) {
  let block = head(number), now = Number(block.timestamp) * 1_000;
  const calls: string[] = [], ranges: [bigint, bigint][] = [];
  const sqrt = sqrtPriceAtTick(150_000);
  const direct = context({
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => {
      calls.push(blockNumber === undefined ? "head" : "block"); return head(Number(blockNumber ?? block.number));
    },
    readContract: async ({ functionName, blockNumber, blockHash, requireCanonical }: { functionName: string; blockNumber?: bigint; blockHash?: string; requireCanonical?: boolean }) => {
      calls.push(functionName);
      if (blockHash) { assert.equal(blockHash, block.hash); assert.equal(requireCanonical, true); }
      else assert.equal(blockNumber, block.number);
      const values: Record<string, unknown> = {
        extsload: `0x${(sqrt | (150_000n << 160n)).toString(16).padStart(64, "0")}`,
        band: [140_000, 160_000, 10n], pendingFloorEth: 2n, pendingAbsorbedTokens: 3n, wallCount: 0n,
        teamAccrued: 0n, teamPaidCumulative: 0n, INITIAL_SQRT_PRICE: sqrt, TEAM_ADDRESS: address(8), absorbedTokenSink: address(9),
        totalSupply: 21_000_000n, totalBurned: 0n, vault: address(10), router: address(11), lens: address(12), forge: address(13),
        enabledFeatures: 13n, moduleRevision: 1n, vaultCount: 1n, vaults: address(10),
        snapshot: lensSnapshot(block), totalStaked: 4n, rewardReserve: 5n, totalCubitPaid: 6n,
        LOCK_DURATION: 86_400n, DAILY_REWARD_BPS: 300n, REWARD_PERIOD: 86_400n,
        launchFee: 9n, launches: 0n, governanceVault: address(24), hookCreationCodeHash: keccak256(linkedHookCreationCode(config)),
        LAUNCH_ETH: 3n, poolManager: config.poolManager, deployer: address(25), lockExtension: 0n,
        held: 7n,
      };
      assert.ok(functionName in values, functionName); return values[functionName];
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push("logs"); ranges.push([fromBlock, toBlock]); return [];
    },
    getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push("launches"); ranges.push([fromBlock, toBlock]); return [];
    },
    multicall: async () => [],
  });
  const market = await readMarket(direct, cubitMarket(config), block);
  const s: DataSnapshot = { schemaVersion: SCHEMA_VERSION, chainId: config.chainId, block, producedAt: now,
    market, registry: market.registry, children: [], markets: {}, eventTimes: {},
    histories: { [config.token]: { parts: [], recent: { fromBlock: 1n, toBlock: block.number, events: [], swaps: [] } } },
    forge: await readForge(direct, address(13), block), governance: await readGovernance(direct, address(24), [], block),
    vaults: [await readVault(direct, address(10), true, null, block)],
  };
  calls.length = 0;
  const visitor = context({ readContract: () => assert.fail("Public reads must not use the visitor relay") });
  return { direct, visitor, s, calls, ranges, now: () => now,
    time(ms: number) { now = ms; }, advance(n: number) { block = head(n); now = Number(block.timestamp) * 1_000; } };
}

const failures: [string, (s: DataSnapshot) => Promise<Response>][] = [
  ["network failure", async () => { throw new TypeError("Network error"); }],
  ["timeout", async () => { throw new DOMException("Timed out", "TimeoutError"); }],
  ["HTTP 500", async () => Response.json({ error: "Data service unavailable." }, { status: 500 })],
  ["HTTP 503", async () => new Response(null, { status: 503 })],
  ["origin refusal", async () => new Response(null, { status: 403 })],
  ["invalid JSON", async () => new Response("unavailable")],
  ["invalid 503 JSON", async () => new Response("unavailable", { status: 503 })],
  ["unreadable body", async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("Read failed")); } }), { status: 503 })],
  ["unsupported schema", async (s) => new Response(stringifyData({ ...s, schemaVersion: 999 }))],
  ["Sepolia snapshot", async (s) => new Response(stringifyData({ ...s, chainId: 11155111 }))],
  ["missing public data", async (s) => new Response(stringifyData({ ...s, vaults: undefined }))],
  ["stale production", async (s) => new Response(stringifyData({ ...s, producedAt: s.producedAt - 60_001 }))],
  ["stale block", async (s) => {
    const block = { ...s.block, timestamp: s.block.timestamp - 301n };
    return new Response(stringifyData({ ...s, block,
      vaults: s.vaults.map((v) => ({ ...v, block, chainTime: block.timestamp })),
    }));
  }],
];

test("the protocol overview retains the shared path without rereading the pool or registry", async () => {
  const f = await fixture();
  const client = new SnapshotClient("https://data.invalid", async () => new Response(stringifyData(f.s)));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  const block = await data.readHead();
  for (const full of [true, false]) {
    const view = await data.protocol(block, full);
    assert.equal(view.marketOpen, true);
    assert.deepEqual(view.registry, f.s.registry);
    assert.deepEqual(view.market, full ? f.s.market : null);
    assert.equal(view.wallEth, f.s.market.wallEth);
  }
  assert.deepEqual(f.calls, []);
});

for (const [name, fail] of failures) test(`public readers start directly after ${name}, then return to shared data`, async () => {
  const f = await fixture(); let healthy = false;
  const client = new SnapshotClient("https://data.invalid", async () => healthy ? new Response(stringifyData(f.s)) : fail(f.s));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  const history = data.history(cubitMarket(config));
  const read = async (block: Awaited<ReturnType<typeof data.readHead>>) => ({
    market: await data.market(cubitMarket(config), block), forge: await data.forge(address(13), block),
    governance: await data.governance(address(24), [], block, null, {}),
    vault: await data.vault(address(10), true, null, block), vaults: await data.vaultAddresses(block),
    children: await data.children(block), history: await history(block),
  });
  const directBlock = await data.readHead();
  assert.equal(directBlock.source, "direct"); assert.equal(data.warning, null);
  const direct = await read(directBlock);
  await data.assertBlock(directBlock);
  assert.deepEqual(direct.market, f.s.market); assert.ok(f.calls.includes("launchFee"));
  assert.ok(f.calls.includes("held")); assert.ok(f.calls.includes("rewardReserve"));
  assert.ok(f.calls.includes("vaults")); assert.ok(f.calls.includes("logs"));
  assert.equal(f.calls.filter((c) => c === "head").length, 1);
  healthy = true; f.calls.length = 0;
  const sharedBlock = await data.readHead();
  assert.equal(sharedBlock.source, "shared"); assert.equal(data.warning, null);
  assert.deepEqual(await read(sharedBlock), direct);
  await data.assertBlock(sharedBlock);
  assert.deepEqual(f.calls, ["block"], "recovery only reads the canonical header; all public getters remain shared");
  assert.equal(data.snapshot(directBlock), null, "an in-flight direct read keeps its source after recovery");
});

test("public source selection falls back as soon as verification exceeds 60 seconds", async () => {
  const f = await fixture();
  const client = new SnapshotClient("https://data.invalid", async () => new Response(stringifyData(f.s)));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  f.time(f.s.producedAt + 60_000);
  const shared = await data.readHead();
  assert.equal(shared.source, "shared");
  assert.equal(data.fresh(shared), true);
  assert.deepEqual(f.calls, []);
  f.time(f.s.producedAt + 60_001);
  const direct = await data.readHead();
  assert.equal(direct.source, "direct");
  assert.equal(data.fresh(shared), false);
  assert.equal(data.fresh(direct), true);
  assert.equal(data.warning, null);
  assert.deepEqual(f.calls, ["head"]);
});

test("public source selection tolerates a verified chain stall for five minutes", async () => {
  const f = await fixture(), blockTime = Number(f.s.block.timestamp) * 1_000;
  const client = new SnapshotClient("https://data.invalid", async () => new Response(stringifyData({ ...f.s, producedAt: f.now() })));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  for (const age of [60_001, 240_000, 300_000]) {
    f.time(blockTime + age);
    assert.equal((await data.readHead()).source, "shared");
    assert.equal(data.warning, null);
  }
  assert.deepEqual(f.calls, []);
  f.time(blockTime + 300_001);
  assert.equal((await data.readHead()).source, "direct");
  assert.equal(client.error, null, "the old block is valid but too old to use");
  assert.equal(data.warning, null);
  assert.deepEqual(f.calls, ["head"]);
});

for (const unavailable of [false, true]) test(`${unavailable ? "unavailable" : "stale"} shared data warns only after five continuous minutes`, async () => {
  const f = await fixture();
  // An old snapshot does not backdate the first observed degradation; zero is also a valid start.
  f.time(unavailable ? 0 : f.now() + 2 * SNAPSHOT_WARNING_MS);
  const client = new SnapshotClient("https://data.invalid", async () => unavailable
    ? new Response(null, { status: 503 }) : new Response(stringifyData(f.s)));
  const data = new PublicData(f.direct, f.visitor, client, f.now), start = f.now();
  const warnings: (string | null)[] = [];
  const stop = data.subscribe(() => warnings.push(data.warning));
  for (const elapsed of [0, 30_000, 60_000, SNAPSHOT_WARNING_MS - 1, SNAPSHOT_WARNING_MS]) {
    f.time(start + elapsed);
    assert.equal((await data.readHead()).source, "direct");
    assert.equal(data.warning, null);
  }
  assert.deepEqual(f.calls, Array(5).fill("head"), "every degraded read falls back immediately");
  assert.deepEqual(warnings, []);
  f.time(start + SNAPSHOT_WARNING_MS + 1);
  assert.equal(data.warning, null, "elapsed time alone cannot publish a warning");
  assert.equal((await data.readHead()).source, "direct");
  const message = unavailable ? "Shared data unavailable. Using the public RPC for live data."
    : "Shared snapshot is stale. Using the public RPC for live data.";
  assert.equal(data.warning, message);
  assert.deepEqual(warnings, [message]);
  f.time(start + SNAPSHOT_WARNING_MS + 30_000);
  await data.readHead();
  assert.equal(data.warning, message);
  stop();
});

for (const [name, fail] of failures) test(`${name} keeps warning after five continuous minutes of retries`, async () => {
  const f = await fixture(), start = f.now();
  const client = new SnapshotClient("https://data.invalid", async () => fail(f.s));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  for (const elapsed of [0, 30_000, SNAPSHOT_WARNING_MS - 1, SNAPSHOT_WARNING_MS, SNAPSHOT_WARNING_MS + 1, 3_600_000]) {
    f.time(start + elapsed);
    assert.equal((await data.readHead()).source, "direct");
    if (elapsed <= SNAPSHOT_WARNING_MS) assert.equal(data.warning, null);
    else assert.match(data.warning!, /Using the public RPC for live data/);
  }
  assert.deepEqual(f.calls, Array(6).fill("head"));
});

test("changing degradation causes preserves the start and publishes the current cause", async () => {
  const f = await fixture(), start = f.now(); let unavailable = false;
  const client = new SnapshotClient("https://data.invalid", async () => unavailable
    ? new Response(null, { status: 503 })
    : new Response(stringifyData({ ...f.s, producedAt: f.s.producedAt - 60_001 })));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  await data.readHead();
  unavailable = true; f.time(start + SNAPSHOT_WARNING_MS - 1);
  await data.readHead(); assert.equal(data.warning, null);
  unavailable = false; f.time(start + SNAPSHOT_WARNING_MS + 1);
  await data.readHead();
  assert.equal(data.warning, "Shared snapshot is stale. Using the public RPC for live data.");
  unavailable = true;
  await data.readHead();
  assert.equal(data.warning, "Shared data unavailable. Using the public RPC for live data.");
});

test("the first fresh snapshot clears the warning and restarts the full grace period", async () => {
  const f = await fixture(), start = f.now(); let published: DataSnapshot | null = null;
  const client = new SnapshotClient("https://data.invalid", async () => published
    ? new Response(stringifyData(published)) : new Response(null, { status: 503 }));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  const warnings: (string | null)[] = [];
  const stop = data.subscribe(() => warnings.push(data.warning));
  await data.readHead();
  f.time(start + SNAPSHOT_WARNING_MS + 1);
  await data.readHead(); assert.match(data.warning!, /unavailable/);
  f.advance(126); published = (await fixture(126)).s;
  assert.equal((await data.readHead()).source, "shared");
  assert.equal(data.warning, null);
  assert.equal(warnings.at(-1), null, "subscribers see recovery on the first fresh read");
  published = null;
  const restarted = f.now();
  for (const elapsed of [0, SNAPSHOT_WARNING_MS - 1, SNAPSHOT_WARNING_MS]) {
    f.time(restarted + elapsed);
    assert.equal((await data.readHead()).source, "direct");
    assert.equal(data.warning, null);
  }
  f.time(restarted + SNAPSHOT_WARNING_MS + 1);
  await data.readHead(); assert.match(data.warning!, /unavailable/);
  stop();
});

test("alternating failures and fresh snapshots never accumulate a warning", async () => {
  const f = await fixture(); let published = f.s, healthy = true, unavailable = false;
  const client = new SnapshotClient("https://data.invalid", async () => !healthy && unavailable
    ? new Response(null, { status: 503 })
    : new Response(stringifyData(healthy ? published : { ...published, producedAt: published.producedAt - 60_001 })));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  for (let cycle = 0; cycle < 6; cycle++) {
    healthy = false; unavailable = cycle % 2 === 0;
    const start = f.now();
    for (const elapsed of [0, SNAPSHOT_WARNING_MS - 1]) {
      f.time(start + elapsed);
      assert.equal((await data.readHead()).source, "direct");
      assert.equal(data.warning, null);
    }
    const number = 100 + (cycle + 1) * 25;
    f.advance(number); published = (await fixture(number)).s; healthy = true;
    assert.equal((await data.readHead()).source, "shared");
    assert.equal(data.warning, null);
  }
});

test("source choices and direct cursors survive shared/direct/shared transitions at the same hash", async () => {
  const f = await fixture(); let healthy = true;
  const client = new SnapshotClient("https://data.invalid", async () => healthy ? new Response(stringifyData(f.s)) : new Response(null, { status: 503 }));
  const data = new PublicData(f.direct, f.visitor, client, f.now), history = data.history(cubitMarket(config));
  const shared = await data.readHead();
  healthy = false;
  const direct = await data.readHead();
  assert.equal(shared.hash, direct.hash); assert.ok(data.snapshot(shared)); assert.equal(data.snapshot(direct), null);
  await history(direct); await data.children(direct);
  healthy = true; await data.readHead();
  f.advance(101); f.ranges.length = 0; healthy = false;
  const next = await data.readHead();
  await history(next); await data.children(next);
  assert.ok(f.ranges.length >= 3);
  assert.ok(f.ranges.every(([from, to]) => from === 95n && to === 101n), "direct cursors reuse their reorg window");
  f.time(f.s.producedAt + 60_001);
  assert.equal(data.fresh(shared), false);
  assert.equal(data.fresh(next), true, "a stale shared snapshot must not disable a direct quote");
});

test("clock coalesces failover, respects 8/30-second cadences and retries recovery without a new block", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(); const start = f.now(); let healthy = true, probes = 0;
  const pending = deferred<Response>();
  const client = new SnapshotClient("https://data.invalid", async () => {
    probes++; if (probes === 1) return pending.promise;
    return healthy ? new Response(stringifyData({ ...f.s, producedAt: f.now() })) : new Response(null, { status: 403 });
  });
  const data = new PublicData(f.direct, f.visitor, client, f.now), clock = new BlockClock(data.readHead);
  const reads: string[][] = [[], []];
  const tasks = [8_000, 30_000].map((interval, i) => new PollTask({ clock, interval, allowed: () => true, now: f.now,
    load: async (b) => data.snapshot(b) ? "shared" : "direct", publish: (v) => reads[i].push(v), error: assert.fail }));
  tasks.forEach((task) => task.start()); t.after(() => tasks.forEach((task) => task.stop()));
  assert.equal(clock.refresh(), clock.refresh()); assert.equal(probes, 1);
  pending.resolve(new Response(stringifyData(f.s))); await clock.refresh(); await flush();
  assert.deepEqual(reads, [["shared"], ["shared"]]);
  const refresh = async (ms: number) => { f.time(start + ms); await clock.refresh(); await flush(); };
  healthy = false; await refresh(2_000);
  assert.equal(clock.error, null); assert.deepEqual(reads, [["shared"], ["shared"]]);
  await refresh(8_000); assert.deepEqual(reads, [["shared", "direct"], ["shared"]]);
  await refresh(30_000); assert.deepEqual(reads, [["shared", "direct"], ["shared", "direct"]]);
  healthy = true; await refresh(32_000);
  assert.deepEqual(reads, [["shared", "direct", "shared"], ["shared", "direct"]]);
  await refresh(60_000);
  assert.deepEqual(reads, [["shared", "direct", "shared"], ["shared", "direct", "shared"]]);
  assert.equal(data.warning, null);
  clock.setVisible(false); const count = probes;
  t.mock.timers.tick(60_000); await clock.refresh(); assert.equal(probes, count);
});

test("unavailable frozen history falls back to the direct history reader at the selected block", async () => {
  const f = await fixture(); let published = f.s;
  f.s.histories[config.token].parts = [{ from: 1n, to: 90n, path: `/data/mainnet/history/${config.token}/1-90/${head(90).hash}.json` }];
  const client = new SnapshotClient("https://data.invalid", async (url) => String(url).endsWith("latest.json")
    ? new Response(stringifyData(published)) : new Response(null, { status: 503 }));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  const block = await data.readHead(), history = data.history(cubitMarket(config)), start = f.now();
  for (const elapsed of [0, SNAPSHOT_WARNING_MS - 1, SNAPSHOT_WARNING_MS]) {
    f.time(start + elapsed);
    assert.equal((await history(block)).toBlock, block.number);
    assert.equal(data.warning, null);
  }
  assert.ok(f.calls.includes("logs"));
  f.time(start + SNAPSHOT_WARNING_MS + 1);
  await history(block);
  assert.equal(data.warning, "Shared history unavailable. Using the public RPC for history.");
  f.advance(126); published = (await fixture(126)).s;
  assert.equal((await data.readHead()).source, "shared");
  assert.equal(data.warning, null);
});

test("snapshot-specific reader errors stay local instead of publishing a source warning", async () => {
  const f = await fixture();
  const client = new SnapshotClient("https://data.invalid", async () => new Response(stringifyData(f.s)));
  const data = new PublicData(f.direct, f.visitor, client, f.now), block = await data.readHead();
  await assert.rejects(data.forge(address(99), block), /Forge changed/);
  await assert.rejects(data.governance(address(99), [], block, null, {}), /Governance vault changed/);
  await assert.rejects(data.vault(address(99), false, null, block), /Vault unavailable in this snapshot/);
  await assert.rejects(data.market({ ...cubitMarket(config), token: address(99), parent: false }, block), /Market unavailable in this snapshot/);
  assert.equal(data.warning, null);
});

test("shared snapshots with missing or conflicting vault provenance fall back to direct reads", async () => {
  const f = await fixture();
  for (const block of [undefined, head(100, 1), { ...head(100), number: 99n }, { ...head(100), timestamp: 0n }]) {
    const invalid = { ...f.s, vaults: f.s.vaults.map((v) => ({ ...v, block })) };
    const client = new SnapshotClient("https://data.invalid", async () => new Response(stringifyData(invalid)));
    const data = new PublicData(f.direct, f.visitor, client, f.now);
    assert.equal((await data.readHead()).source, "direct");
    assert.equal(data.warning, null);
  }
});

test("shared block publication rejects an orphan or an unavailable canonical header", async () => {
  const f = await fixture();
  const client = new SnapshotClient("https://data.invalid", async () => new Response(stringifyData(f.s)));
  const data = new PublicData(f.direct, f.visitor, client, f.now);
  const selected = await data.readHead();
  await data.assertBlock(selected);
  f.direct.client.getBlock = (async () => head(100, 1)) as typeof f.direct.client.getBlock;
  await assert.rejects(data.assertBlock(selected), /block changed/i);
  f.direct.client.getBlock = (async () => { throw new Error("Header unavailable"); }) as typeof f.direct.client.getBlock;
  await assert.rejects(data.assertBlock(selected), /unavailable/i);
});
