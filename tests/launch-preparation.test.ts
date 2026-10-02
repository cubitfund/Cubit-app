import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 } from "viem";
import { BlockClock } from "../src/chain/blockClock.ts";
import { readActionBlock } from "../src/chain/readContext.ts";
import { linkedHookCreationCode, readForge } from "../src/chain/launchpad.ts";
import { TransactionCancelled } from "../src/chain/txSequence.ts";
import { address, config, context, deferred, flush, head } from "./helpers.ts";

for (const pause of ["hidden", "unsubscribed"] as const) test(`launch preparation reads a fresh block with the clock ${pause}`, async () => {
  let headReads = 0;
  let contractReads = 0;
  let periodicReads = 0;
  const clock = new BlockClock(async () => { periodicReads++; return head(1); });
  clock.setVisible(pause !== "hidden");
  const stop = pause === "hidden" ? clock.subscribe(() => {}, 8_000) : () => {};
  const ctx = context({
    getBlock: async (args: unknown) => { assert.deepEqual(args, { blockTag: "latest" }); headReads++; return head(100); },
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
      assert.equal(blockNumber, 100n); contractReads++;
      return ({ launchFee: 1n, launches: 2n, governanceVault: address(8), hookCreationCodeHash: keccak256(linkedHookCreationCode(config)), LAUNCH_ETH: 3n, poolManager: config.poolManager } as Record<string, unknown>)[functionName];
    },
  });
  const block = await readActionBlock(ctx, () => clock.refresh(), () => {});
  const forge = await readForge(ctx, config.forge, block);
  assert.equal(forge.templateMatches, true);
  assert.equal(forge.launchFee, 1n);
  assert.equal(headReads, 1);
  assert.equal(contractReads, 6);
  assert.equal(periodicReads, 0, "an action must not resume the periodic clock");
  assert.equal(clock.block, null);
  stop();
});

test("launch preparation reuses a visible clock's head without another direct read", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let headReads = 0;
  const clock = new BlockClock(async () => { headReads++; return head(100); });
  const stop = clock.subscribe(() => {}, 8_000);
  const ctx = context({ getBlock: async () => { throw new Error("Unexpected direct read"); } });
  assert.deepEqual(await readActionBlock(ctx, () => clock.refresh(), () => {}), head(100));
  assert.equal(headReads, 1, "the subscription and explicit action share the pending head read");
  stop();
});

test("a paused-clock launch can still be cancelled during its direct block read", async () => {
  const pending = deferred<ReturnType<typeof head>>();
  let cancelled = false;
  const ctx = context({ getBlock: () => pending.promise });
  const read = readActionBlock(ctx, async () => null, () => { if (cancelled) throw new TransactionCancelled(); });
  const rejected = assert.rejects(read, TransactionCancelled);
  await flush();
  cancelled = true;
  pending.resolve(head(100));
  await rejected;
});
