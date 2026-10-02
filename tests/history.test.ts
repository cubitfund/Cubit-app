import assert from "node:assert/strict";
import { test } from "node:test";
import { chunked, createLogCursor } from "../src/chain/logCursor.ts";
import { createBlockTimes, mergeHistory, type MarketHistory } from "../src/chain/events.ts";
import { context, hash, head } from "./helpers.ts";

const event = (block: number, id: string, branch = 0) => ({ block, blockHash: hash(block, branch), id, kind: "BUY" as const, tx: hash(2), logIndex: 0 });
const history = (from: bigint, to: bigint, events = [] as ReturnType<typeof event>[]): MarketHistory => ({ fromBlock: from, toBlock: to, events, swaps: [] });

test("history replaces the complete window, including disappearance and head rollback", () => {
  const older = history(1n, 12n, [event(1, "stable"), event(8, "orphan"), event(12, "future")]);
  const newer = history(7n, 10n, [event(9, "replacement", 1)]);
  const merged = mergeHistory(older, newer);
  assert.deepEqual(merged.events.map((e) => e.id), ["stable", "replacement"]);
  assert.equal(merged.toBlock, 10n);
  assert.deepEqual(mergeHistory(older, history(7n, 12n)).events.map((e) => e.id), ["stable"]);
});

test("cursor advances incrementally, replaces recent forks and rebuilds after a deeper reorg", async () => {
  let logs = [event(2, "stable"), event(19, "orphan")];
  let branchFrom = Infinity;
  const ranges: bigint[][] = [];
  const hashAt = async (n: bigint) => hash(Number(n), Number(n) >= branchFrom ? 1 : 0);
  const cursor = createLogCursor(1n, async (from, to) => {
    ranges.push([from, to]); return logs.filter((l) => l.block >= from && l.block <= to);
  }, hashAt);
  await cursor.read(head(20));
  await cursor.read(head(22));
  assert.deepEqual(ranges, [[1n, 20n], [15n, 22n]]);
  await cursor.read(head(22));
  assert.equal(ranges.length, 2);
  branchFrom = 19; logs = [event(2, "stable"), event(23, "new", 1)];
  const shortFork = await cursor.read(head(23, 1));
  assert.deepEqual(shortFork.map((r) => r.id), ["stable", "new"]);
  branchFrom = 2; logs = [event(3, "deep replacement", 1)];
  const deepFork = await cursor.read(head(24, 1));
  assert.deepEqual(ranges.at(-1), [1n, 24n]);
  assert.deepEqual(deepFork.map((r) => r.id), ["deep replacement"]);
  await cursor.read(head(5, 1));
  assert.deepEqual(ranges.at(-1), [1n, 5n]);
});

test("a failed range or inconsistent head does not advance the cursor", async () => {
  let fail = false;
  let inconsistent = false;
  const ranges: bigint[][] = [];
  const cursor = createLogCursor(1n, async (from, to) => {
    ranges.push([from, to]); if (fail) throw new Error("unavailable"); return [];
  }, async (n) => hash(Number(n), inconsistent && n === 12n ? 1 : 0));
  await cursor.read(head(10));
  fail = true; await assert.rejects(cursor.read(head(11)), /unavailable/);
  fail = false; inconsistent = true; await assert.rejects(cursor.read(head(12)), /changed/);
  inconsistent = false; await cursor.read(head(13));
  assert.deepEqual(ranges.slice(1).map((r) => r[0]), [5n, 5n, 5n]);
});

test("a prefix that changes during the new anchor lookup cannot be committed", async () => {
  let fork = false, race = false;
  const ranges: bigint[][] = [];
  const cursor = createLogCursor(1n, async (from, to) => {
    ranges.push([from, to]);
    return !fork && from <= 2n ? [event(2, "orphan")] : [];
  }, async (n) => {
    if (race && n === 15n) fork = true;
    // Simulate inconsistent upstreams: even a stale head response must not authorize the changed prefix.
    return hash(Number(n), fork && n < 20n ? 1 : 0);
  });
  await cursor.read(head(20));
  race = true;
  await assert.rejects(cursor.read(head(21)), /prefix changed/);
  race = false;
  assert.deepEqual(await cursor.read(head(22)), []);
  assert.deepEqual(ranges, [[1n, 20n], [15n, 21n], [1n, 22n]]);
});

test("same-head cache hits still validate the anchor and canonical head", async () => {
  let fork = false;
  const cursor = createLogCursor(1n, async () => [], async (n) => hash(Number(n), fork ? 1 : 0));
  await cursor.read(head(20));
  fork = true;
  await assert.rejects(cursor.read(head(20)), /head changed/);
  // Before the first possible anchor, the head guard still applies.
  const young = createLogCursor(20n, async () => [], async (n) => hash(Number(n), fork ? 1 : 0));
  fork = false;
  await young.read(head(20));
  fork = true;
  await assert.rejects(young.read(head(20)), /head changed/);
});

test("range splitting has inclusive nonoverlapping bounds and retries only refused ranges", async () => {
  const successful: bigint[][] = [];
  const values = await chunked(1n, 10_002n, async (from, to) => {
    if (to - from > 2_999n) throw { code: -32614 };
    successful.push([from, to]); return [from];
  });
  assert.equal(values.length, 5);
  assert.equal(successful[0][0], 1n);
  assert.equal(successful.at(-1)![1], 10_002n);
  successful.slice(1).forEach((range, i) => assert.equal(range[0], successful[i][1] + 1n));
  await assert.rejects(chunked(1n, 2n, async () => { throw new Error("fetch failed"); }), /fetch failed/);
});

test("timestamp cache is identified by block hash and invalidates on reorg", async () => {
  let branch = 0;
  let calls = 0;
  const ctx = context({ getBlock: async () => { calls++; return { hash: hash(1, branch), timestamp: branch ? 20n : 10n }; } });
  const times = createBlockTimes();
  assert.equal((await times(ctx, [event(1, "a")])).get(1), 10_000);
  await times(ctx, [event(1, "a")]); assert.equal(calls, 1);
  branch = 1;
  assert.equal((await times(ctx, [event(1, "a", 1)])).get(1), 20_000);
  assert.equal(calls, 2);
  await assert.rejects(times(ctx, [event(1, "stale", 2)]), /changed/);
});
