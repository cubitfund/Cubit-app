import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidParamsRpcError, RpcRequestError } from "viem";
import { classifyRpcError, isHeadLag, withHeadLagRetry } from "../src/chain/rpcErrors.ts";
import { chunked } from "../src/chain/logCursor.ts";
import { RequestPool } from "../src/chain/requestPool.ts";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("RPC classifications distinguish throughput, quota, range, deterministic errors and outage", () => {
  for (const [error, expected] of [
    [{ status: 429 }, "rate"], [{ code: -32007 }, "rate"],
    [{ status: 429, details: "Monthly credits exhausted" }, "quota"],
    [{ status: 402 }, "quota"], [{ message: "credits exhausted" }, "quota"], [{ message: "monthly limit reached" }, "quota"],
    [{ cause: { status: 413, code: -32614 } }, "range"],
    [{ code: -32005, message: "query returned more than 10000 results" }, "range"],
    [{ code: -32602 }, "deterministic"], [{ code: 3 }, "deterministic"],
    [{ cause: { status: 503 } }, "outage"], [new Error("fetch failed"), "outage"],
  ] as const) assert.equal(classifyRpcError(error), expected);
});

// The exact error the app showed on refresh: a node of the public endpoint behind the pinned head.
const headLag = () => new InvalidParamsRpcError(new RpcRequestError({
  body: { method: "eth_getLogs" }, url: "https://ethereum-rpc.publicnode.com",
  error: { code: -32602, message: "block range extends beyond current head block" },
}));

test("a node behind the pinned head is a transient lag, not a deterministic refusal", () => {
  assert.equal(isHeadLag(headLag()), true);
  assert.equal(classifyRpcError(headLag()), "outage");
  assert.equal(isHeadLag({ code: -32001, message: "block not found: 0x18d4a56" }), true);
  // A bare invalid-params refusal stays deterministic.
  assert.equal(isHeadLag({ code: -32602 }), false);
  assert.equal(classifyRpcError({ code: -32602 }), "deterministic");
});

test("the public transport retries a lagging node and nothing else", async () => {
  const noWait = async () => {};
  let calls = 0;
  assert.equal(await withHeadLagRetry(async () => { if (++calls < 2) throw headLag(); return "logs"; }, 2, 0, noWait), "logs");
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(withHeadLagRetry(async () => { calls++; throw headLag(); }, 2, 0, noWait), InvalidParamsRpcError);
  assert.equal(calls, 3, "two retries at most");

  calls = 0;
  await assert.rejects(withHeadLagRetry(async () => { calls++; throw new Error("execution reverted"); }, 2, 0, noWait));
  assert.equal(calls, 1, "any other failure is returned at once");
});

test("log reads do not halve a range refused by a lagging node, but still halve a real range limit", async () => {
  let calls = 0;
  await assert.rejects(chunked(26_029_502n, 26_036_867n, async () => { calls++; throw headLag(); }), InvalidParamsRpcError);
  assert.equal(calls, 1, "halving cannot help: the upper half still holds the unknown block");

  const ranges: [bigint, bigint][] = [];
  const logs = await chunked(0n, 3n, async (from, to) => {
    ranges.push([from, to]);
    if (to - from >= 2n) throw { code: -32005, message: "query returned more than 10000 results" };
    return [from];
  });
  assert.deepEqual(logs, [0n, 2n]);
  assert.deepEqual(ranges, [[0n, 3n], [0n, 1n], [2n, 3n]]);
});

test("public fallback bounds concurrency and its deadline includes queueing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pool = new RequestPool(2, 1_000);
  let started = 0;
  const signals: AbortSignal[] = [];
  const completions: (() => void)[] = [];
  const request = (signal: AbortSignal) => {
    started++; signals.push(signal);
    return new Promise<void>((resolve) => completions.push(resolve));
  };
  const jobs = Array.from({ length: 5 }, () => pool.run(request));
  const checked = jobs.map((job) => assert.rejects(job, /deadline/));
  await flush();
  assert.equal(started, 2);
  t.mock.timers.tick(1_000);
  await Promise.all(checked);
  assert.ok(signals.every((s) => s.aborted));
  // Uncooperative transports retain their slots; expired queued requests must never start.
  completions.forEach((done) => done());
  await flush();
  assert.equal(started, 2);
  assert.equal(await pool.run(async () => "recovered"), "recovered");
});

test("public fallback frees a slot after failure", async () => {
  const pool = new RequestPool(1);
  const first = pool.run(async () => { throw new Error("unavailable"); });
  const second = pool.run(async () => 42);
  await assert.rejects(first, /unavailable/);
  assert.equal(await second, 42);
});
