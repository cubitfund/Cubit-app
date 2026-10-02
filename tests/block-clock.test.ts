import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockClock, MIN_BLOCK_POLL_MS, MAX_BLOCK_POLL_MS } from "../src/chain/blockClock.ts";
import { PollTask } from "../src/chain/pollTask.ts";
import { deferred, flush, head } from "./helpers.ts";

test("one shared head read for multiple subscribers and concurrent refreshes; pauses without consumers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const read = deferred<ReturnType<typeof head>>();
  const clock = new BlockClock(() => { calls++; return read.promise; });
  const a = clock.subscribe(() => {}, 8_000);
  const b = clock.subscribe(() => {}, 30_000);
  const one = clock.refresh();
  assert.equal(clock.refresh(), one);
  assert.equal(calls, 1);
  read.resolve(head(1));
  await one;
  clock.setVisible(false);
  t.mock.timers.tick(40_000);
  await clock.refresh();
  assert.equal(calls, 1);
  clock.setVisible(true);
  await flush();
  assert.equal(calls, 2);
  a(); b();
  t.mock.timers.tick(40_000);
  assert.equal(calls, 2);
});

test("consumers retain 8 s and 30 s cadences and do not reread an unchanged block", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  let block = head(1);
  const clock = new BlockClock(async () => block);
  const reads = [[], []] as bigint[][];
  const tasks = [8_000, 30_000].map((interval, i) => new PollTask({
    clock, interval, now: () => now, allowed: () => true,
    load: async (b) => { reads[i].push(b.number); return b; }, publish: () => {}, error: (e) => { throw e; },
  }));
  tasks.forEach((task) => task.start());
  await flush();
  now = 8_000; await clock.refresh(); await flush();
  assert.deepEqual(reads, [[1n], [1n]]);
  block = head(2); now = 12_000; await clock.refresh(); await flush();
  assert.deepEqual(reads, [[1n, 2n], [1n]]);
  block = head(3); now = 24_000; await clock.refresh(); await flush();
  assert.deepEqual(reads, [[1n, 2n, 3n], [1n]]);
  now = 30_000; await clock.refresh(); await flush();
  assert.deepEqual(reads, [[1n, 2n, 3n], [1n, 3n]]);
  tasks.forEach((task) => task.stop());
});

for (const stop of ["hidden", "disabled", "unmounted"] as const) test(`queued and explicit refresh do not start after ${stop}`, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const pending = deferred<number>();
  let allowed = true;
  let reads = 0;
  let published = 0;
  let block = head(1);
  const clock = new BlockClock(async () => block);
  const poll = new PollTask({ clock, interval: 8_000, allowed: () => allowed,
    load: () => { reads++; return pending.promise; }, publish: () => { published++; }, error: () => {} });
  poll.start(); await flush();
  block = head(2);
  await poll.refresh(); // queues again while the first read is pending
  if (stop === "unmounted") poll.stop();
  else { allowed = false; if (stop === "hidden") clock.setVisible(false); }
  pending.resolve(1); await flush(); await poll.refresh(); await flush();
  assert.equal(reads, 1);
  if (stop === "unmounted") assert.equal(published, 0);
  poll.stop();
});

test("StrictMode cleanup invalidates old work while the next mount can read", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const pending = deferred<number>();
  const values: number[] = [];
  const clock = new BlockClock(async () => head(1));
  const make = (load: () => Promise<number>) => new PollTask({ clock, interval: 8_000, allowed: () => true, load, publish: (n) => values.push(n), error: () => {} });
  const old = make(() => pending.promise);
  old.start(); await flush(); old.stop();
  const next = make(async () => 2);
  next.start(); await flush();
  pending.resolve(1); await flush();
  assert.deepEqual(values, [2]);
  next.stop();
});

test("same-height replacement block is a new snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let block = head(1);
  let now = 0;
  const clock = new BlockClock(async () => block);
  const hashes: string[] = [];
  const task = new PollTask({ clock, interval: 8_000, allowed: () => true, now: () => now,
    load: async (b) => b.hash, publish: (h) => hashes.push(h), error: () => {} });
  task.start(); await flush();
  block = head(1, 1); now = 8_000; await clock.refresh(); await flush();
  assert.deepEqual(hashes, [head(1).hash, head(1, 1).hash]);
  task.stop();
});

test("polling recovers at the same hash after a head or publication validation failure", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const failure of ["head", "validation"]) {
    let failing = false, now = 0, published = 0, errors = 0;
    const clock = new BlockClock(async () => {
      if (failing && failure === "head") throw new Error("Head unavailable");
      return head(100);
    });
    const task = new PollTask({ clock, interval: 8_000, allowed: () => true, now: () => now,
      load: async (block) => {
        if (failing) throw new Error("Canonical header unavailable");
        return block;
      }, publish: () => { published++; }, error: () => { errors++; },
    });
    task.start(); await flush();
    assert.equal(published, 1);
    failing = true;
    await task.refresh(); await flush();
    assert.ok(errors > 0);
    assert.equal(published, 1, "no value is published after failed validation");
    failing = false; now = 8_000;
    await clock.refresh(); await flush();
    assert.equal(published, 2, "the cleared view can recover without waiting for a different block");
    task.stop();
  }
});


test("head cadence follows arrivals and departures of 30 s and 8 s subscribers", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const clock = new BlockClock(async () => { calls++; return head(calls); });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const slow = clock.subscribe(() => {}, 30_000);
  await flush();
  assert.equal(calls, 1, "the first subscriber gets an immediate head");
  await advance(29_999); assert.equal(calls, 1);
  await advance(1); assert.equal(calls, 2);
  const fast = clock.subscribe(() => {}, 8_000);
  await flush(); assert.equal(calls, 2, "joining shares the existing head");
  await advance(7_999); assert.equal(calls, 2);
  await advance(1); assert.equal(calls, 3);
  await advance(8_000); assert.equal(calls, 4);
  const otherSlow = clock.subscribe(() => {}, 30_000);
  await advance(8_000); assert.equal(calls, 5, "a slower arrival does not reset the fast timer");
  slow();
  await advance(8_000); assert.equal(calls, 6, "removing a slower subscriber keeps the fast cadence");
  fast();
  await advance(29_999); assert.equal(calls, 6);
  await advance(1); assert.equal(calls, 7, "only the remaining 30 s consumer determines the cadence");
  clock.setVisible(false);
  const hiddenFast = clock.subscribe(() => {}, 8_000);
  await advance(60_000); assert.equal(calls, 7);
  clock.setVisible(true); await flush(); assert.equal(calls, 8);
  await advance(8_000); assert.equal(calls, 9);
  otherSlow(); hiddenFast();
  await advance(60_000); assert.equal(calls, 9, "no subscribers means no head reads");
});

test("head cadence bounds protect against accidental extreme or invalid intervals", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const clock = new BlockClock(async () => { calls++; return head(calls); });
  const fast = clock.subscribe(() => {}, 1);
  await flush();
  t.mock.timers.tick(MIN_BLOCK_POLL_MS - 1); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  fast();
  const slow = clock.subscribe(() => {}, 1_000_000);
  await flush(); assert.equal(calls, 3);
  t.mock.timers.tick(MAX_BLOCK_POLL_MS); await flush(); assert.equal(calls, 4);
  slow();
  for (const interval of [0, -1, NaN, Infinity]) assert.throws(() => clock.subscribe(() => {}, interval), RangeError);
});
