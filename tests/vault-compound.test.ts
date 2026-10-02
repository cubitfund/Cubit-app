import assert from "node:assert/strict";
import { test } from "node:test";
import { compoundPlan } from "../src/chain/vault.ts";

const unit = 10n ** 18n;
const position = { staked: 1_000n * unit, pending: 30n * unit, unlockAt: 0n, lastRewardAt: 0n, wallet: 0n, allowance: 0n };

test("Compound restakes exactly the claimable reward, approving it first when the allowance is short", () => {
  assert.deepEqual(compoundPlan(position), { amount: 30n * unit, approve: true });
  assert.deepEqual(compoundPlan({ ...position, allowance: 29n * unit }), { amount: 30n * unit, approve: true });
  assert.deepEqual(compoundPlan({ ...position, allowance: 30n * unit }), { amount: 30n * unit, approve: false });
  // The wallet balance plays no part: stake() pays the reward to the wallet before taking the amount back.
  assert.deepEqual(compoundPlan({ ...position, wallet: 0n, allowance: 2n ** 255n }), { amount: 30n * unit, approve: false });
});

test("Compound offers nothing without a position or a claimable reward", () => {
  assert.equal(compoundPlan(null), null);
  assert.equal(compoundPlan({ ...position, pending: 0n }), null);
  assert.equal(compoundPlan({ ...position, staked: 0n, pending: 0n }), null);
});
