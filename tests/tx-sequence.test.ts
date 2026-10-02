import assert from "node:assert/strict";
import { test } from "node:test";
import { runTxSteps, SLOW_RECEIPT_MS, TransactionCancelled, waitForInclusion } from "../src/chain/txSequence.ts";
import { deferred } from "./helpers.ts";

for (const stage of ["preparation", "receipt"] as const) test(`cancellation during ${stage} prevents subsequent signing`, async () => {
  let cancelled = false;
  let signatures = 0;
  const check = () => { if (cancelled) throw new TransactionCancelled(); };
  const steps = [
    { label: "Approve", request: async () => { if (stage === "preparation") cancelled = true; return "approve"; } },
    { label: "Swap", request: async () => "swap" },
  ];
  await assert.rejects(runTxSteps(steps, check, async () => { signatures++; cancelled = true; }, () => {}), TransactionCancelled);
  assert.equal(signatures, stage === "preparation" ? 0 : 1);
});

test("already cancelled and skipped approvals cannot report success", async () => {
  let active = false;
  await assert.rejects(runTxSteps([], () => { if (!active) throw new TransactionCancelled(); }, async () => {}, () => {}), TransactionCancelled);
  active = true;
  let signatures = 0;
  await runTxSteps([{ label: "approved", request: async () => null }, { label: "swap", request: async () => "swap" }], () => {}, async () => { signatures++; }, () => {});
  assert.equal(signatures, 1);
});

test("a slow inclusion is reported, never abandoned", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const receipt = deferred<string>();
  let slow = 0;
  const waited = waitForInclusion(() => receipt.promise, () => { slow++; }, 60_000);
  t.mock.timers.tick(59_999);
  assert.equal(slow, 0);
  t.mock.timers.tick(1);
  assert.equal(slow, 1, "the wait is announced, and the transaction is still being waited for");
  receipt.resolve("mined");
  assert.equal(await waited, "mined", "the receipt still resolves the call that was called slow");
});

test("an inclusion inside the window never announces a wait, and a failure still propagates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let slow = 0;
  assert.equal(await waitForInclusion(async () => "mined", () => { slow++; }, 60_000), "mined");
  await assert.rejects(waitForInclusion(async () => { throw new Error("rpc down"); }, () => { slow++; }, 60_000), /rpc down/);
  t.mock.timers.tick(120_000);
  assert.equal(slow, 0, "a settled wait cancels its timer");
});

test("the wait is only questioned after the four minutes the app used to abandon at", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(SLOW_RECEIPT_MS, 240_000);
  const receipt = deferred<string>();
  let asked = 0;
  const waited = waitForInclusion(() => receipt.promise, () => { asked++; });
  t.mock.timers.tick(SLOW_RECEIPT_MS - 1);
  assert.equal(asked, 0);
  t.mock.timers.tick(1);
  assert.equal(asked, 1, "the user is asked once, and the transaction is still being waited for");
  receipt.resolve("mined");
  assert.equal(await waited, "mined");
});
