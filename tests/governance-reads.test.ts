import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { CubitGovernanceVaultAbi } from "../src/chain/abi.ts";
import { readGovernance } from "../src/chain/launchpad.ts";
import { GOVERNANCE_DETAIL_MS, GOVERNANCE_MAX_READS, readGovernanceDetails, readTranchePage } from "../src/chain/tranches.ts";
import { address, config, context, deferred, flush, head } from "./helpers.ts";

const block = head(100), owner = address(7), vault = address(8);
// Callee gas measured independently on the real vault by the small Forge test. No compilation in pnpm test.
const measuredGas = JSON.parse(readFileSync(new URL("./fixtures/governance-getter-gas.json", import.meta.url), "utf8"))
  .byTrancheCount as Record<string, Record<string, number>>;
type Call = { functionName: string; args?: readonly unknown[]; blockHash?: string; blockNumber?: bigint; requireCanonical?: boolean };
function fixture(count: number, next = 0, matured = Math.max(0, Math.min(count, 50) - next)) {
  const tranches = Array.from({ length: count }, (_, i) => ({ index: BigInt(i), amount: BigInt(i + 1),
    unlockAt: i < next + matured ? block.timestamp : block.timestamp + 100n }));
  const calls: Call[] = [];
  const held = tranches.slice(next).reduce((sum, row) => sum + row.amount, 0n);
  let extension = 0n;
  const read = async (call: Call): Promise<unknown> => {
    calls.push(call);
    assert.equal(call.blockHash, block.hash);
    assert.equal(call.requireCanonical, true);
    assert.equal(call.blockNumber, undefined);
    const fixed: Record<string, unknown> = { deployer: owner, LOCK_DURATION: 2_592_000n, lockExtension: extension,
      held, trancheCount: BigInt(count), nextTranche: BigInt(next) };
    if (call.functionName === "tranche") {
      const row = tranches[Number(call.args![1])];
      assert.ok(row && row.index >= BigInt(next), "never read a deleted row or beyond count");
      return [row.amount, row.unlockAt + extension];
    }
    assert.ok(call.functionName in fixed, `Forbidden/unexpected read: ${call.functionName}`);
    return fixed[call.functionName];
  };
  return { ctx: context({ readContract: read }), read, calls, tranches, held,
    extend(seconds: bigint) { extension = seconds; } };
}
const summary = (f: ReturnType<typeof fixture>, page: number | null = null, signal?: AbortSignal) =>
  readGovernanceDetails(f.ctx, vault, zeroAddress, f.held, block, page, signal);
const own = (f: ReturnType<typeof fixture>) => readGovernance(f.ctx, vault, [], block, owner, { [zeroAddress]: null });

test("visitor cost: 0, 4000 and 20000 tranches have identical RPC counts, ABI bytes and measured getter gas", async (t) => {
  const tokens = Array.from({ length: 12 }, (_, i) => ({ token: address(100 + i), symbol: `T${i}` }));
  for (const count of [0, 4_000, 20_000]) {
    const f = fixture(count);
    let requests = 0, inputBytes = 0, outputBytes = 0, gas = 0;
    const client = createPublicClient({ chain: mainnet, batch: { multicall: { wait: 1 } }, transport: custom({
      async request(request) {
        requests++;
        assert.equal(request.method, "eth_call");
        const [tx, selector] = request.params as any;
        assert.equal(tx.to.toLowerCase(), vault.toLowerCase());
        assert.deepEqual(selector, { blockHash: block.hash, requireCanonical: true });
        const decoded = decodeFunctionData({ abi: CubitGovernanceVaultAbi, data: tx.data });
        assert.ok(["deployer", "LOCK_DURATION", "lockExtension", "held"].includes(decoded.functionName));
        gas += measuredGas[String(count)][decoded.functionName];
        const result = await f.read({ ...decoded, ...selector });
        const data = encodeFunctionResult({ abi: CubitGovernanceVaultAbi, functionName: decoded.functionName, result } as any);
        inputBytes += (tx.data.length - 2) / 2; outputBytes += (data.length - 2) / 2;
        return data;
      },
    }, { retryCount: 0 }) });
    const ctx = { client, config };
    for (const account of [null, address(9)]) {
      requests = inputBytes = outputBytes = gas = 0;
      const view = await readGovernance(ctx, vault, tokens, block, account);
      assert.equal(requests, 16); assert.equal(inputBytes, 480); assert.equal(outputBytes, 512);
      assert.equal(gas, 34_699);
      assert.ok(view.assets.every((a) => a.held === f.held && a.details === null && a.detailError === null));
      const shared = await readGovernance(ctx, vault, tokens, block, account, {}, view);
      assert.deepEqual(shared, view); assert.equal(requests, 16, "shared visitors add zero RPC calls");
    }
    t.diagnostic(`${count} tranches: 16 eth_call, ${inputBytes} input ABI bytes, ${outputBytes} output ABI bytes, ${gas} cold getter gas; shared: 0 RPC`);
  }
});


test("detail call counts for 0, 10, 100, 400, 4000 and 20000 rows with locked, mature and mixed books", async (t) => {
  const measured: Record<number, Record<number, number>> = {
    0: { 0: 4 }, 10: { 0: 5, 10: 6, 1: 13 },
    100: { 0: 5, 100: 6, 1: 16, 40: 52, 41: 55 },
    400: { 0: 5, 400: 6, 1: 18, 40: 54, 41: 57 },
    4000: { 0: 5, 4000: 6, 1: 21, 40: 58, 41: 61, 400: 18 },
    20000: { 0: 5, 20000: 6, 1: 24, 40: 62, 41: 64, 400: 20 },
  };
  for (const n of [0, 10, 100, 400, 4_000, 20_000]) {
    const counts: Record<string, number | string> = {};
    for (const m of [...new Set([0, n, 1, 40, 41, 400])].filter((m) => m <= n)) {
      const f = fixture(n, 0, m);
      if (m === 400 && m < n) {
        await assert.rejects(summary(f), /too many matured tranches.*batches of 64/);
        assert.ok(f.calls.length < 25, "reject an unaffordable prefix before summing any pages");
        counts[`M=${m}`] = `${f.calls.length} (budget)`;
      } else {
        const d = await summary(f);
        const expected = BigInt(m * (m + 1) / 2);
        assert.equal(d.claimable, expected); assert.equal(d.locked, f.held - expected);
        assert.equal(d.claimableTranches, BigInt(m));
        assert.equal(d.nextLocked?.index ?? null, m === n ? null : BigInt(m));
        assert.deepEqual(d.tranches, [], "numeric detail does not load the visible page");
        if (n === 0) assert.equal(f.calls.length, 4);
        else if (m === 0) assert.equal(f.calls.length, 5);
        else if (m === n) assert.equal(f.calls.length, n === 1 ? 5 : 6);
        else assert.ok(f.calls.length <= m + Math.ceil(Math.log2(n)) + 8 + 2 * Math.ceil(m / 40));
        counts[`M=${m}`] = f.calls.length;
      }
      assert.ok(f.calls.length <= GOVERNANCE_MAX_READS);
      assert.equal(f.calls.length, measured[n][m], `N=${n}, M=${m}: detail calls`);
      assert.ok(!f.calls.some((c) => ["locked", "claimable"].includes(c.functionName)));
    }
    t.diagnostic(`N=${n}: ${JSON.stringify(counts)}`);
  }
});

test("page navigation reads only a bounded visible page and the matured prefix, with identical exact totals", async () => {
  const f = fixture(4_000, 3, 41);
  const s = await summary(f);
  assert.equal(s.claimable, f.tranches.slice(3, 44).reduce((sum, r) => sum + r.amount, 0n));
  assert.equal(s.nextLocked!.index, 44n);
  f.calls.length = 0;
  const first = await summary(f, 0);
  assert.deepEqual(first.tranches, f.tranches.slice(3, 43));
  assert.equal(first.claimable, s.claimable);
  f.calls.length = 0;
  const last = await summary(f, 1000);
  assert.equal(last.page, 99); assert.equal(last.tranches[0].index, 3963n);
  assert.equal(last.tranches.length, 37); assert.equal(last.claimable, first.claimable);
  assert.ok(f.calls.length <= GOVERNANCE_MAX_READS);
});

test("an extension moves the boundary using the contract's already extended dates exactly once", async () => {
  const f = fixture(100, 0, 50);
  for (const row of f.tranches) row.unlockAt = block.timestamp + row.index - 49n;
  const before = await summary(f);
  assert.equal(before.claimableTranches, 50n);
  f.extend(20n);
  const after = await summary(f);
  assert.equal(after.claimableTranches, 30n);
  assert.equal(after.nextLocked!.unlockAt, block.timestamp + 1n);
  assert.equal(after.claimable, 465n);
  f.extend(50n);
  assert.equal((await summary(f)).claimable, 0n);
});

test("empty/all-claimed books and a large deleted prefix do not scan old rows", async () => {
  for (const [count, next, matured] of [[0, 0, 0], [20_000, 20_000, 0], [20_000, 19_990, 4]]) {
    const f = fixture(count, next, matured), d = await summary(f);
    assert.equal(d.claimable, f.tranches.slice(next, next + matured).reduce((s, r) => s + r.amount, 0n));
    assert.equal(d.locked, f.held - d.claimable);
    assert.ok(f.calls.length < 25);
  }
});

test("real viem detail requests keep every probe, page and bound at one canonical hash with multicall enabled", async () => {
  const f = fixture(85);
  const client = createPublicClient({ chain: mainnet, batch: { multicall: { wait: 1 } }, transport: custom({
    async request(request) {
      assert.equal(request.method, "eth_call");
      const [tx, selector] = request.params as any;
      assert.equal(tx.to.toLowerCase(), vault.toLowerCase());
      assert.deepEqual(selector, { blockHash: block.hash, requireCanonical: true });
      const decoded = decodeFunctionData({ abi: CubitGovernanceVaultAbi, data: tx.data });
      const result = await f.read({ ...decoded, ...selector });
      return encodeFunctionResult({ abi: CubitGovernanceVaultAbi, functionName: decoded.functionName, result } as any);
    },
  }, { retryCount: 0 }) });
  const d = await readGovernanceDetails({ client }, vault, zeroAddress, f.held, block);
  assert.equal(d.claimable, 1275n);
  assert.ok(f.calls.length < 70, "the locked suffix is not scanned");
});

test("a failed later page, changed bounds, deleted row, unordered dates or excessive amount discards all detail; retry is fresh", async () => {
  for (const fault of ["rpc", "count", "cursor", "deleted", "date", "sum", "invalid-cursor"]) {
    const f = fixture(85); let bad = true;
    f.ctx.client.readContract = (async (call: Call) => {
      const value = await f.read(call);
      const summing = f.calls.some((c) => c.functionName === "tranche" && c.args![1] === 10n);
      if (bad) {
        if (call.functionName === "nextTranche" && fault === "invalid-cursor") return 86n;
        if (summing && call.functionName === "trancheCount" && fault === "count") return 86n;
        if (summing && call.functionName === "nextTranche" && fault === "cursor") return 1n;
        if (call.functionName === "tranche" && call.args![1] === 40n) {
          if (fault === "rpc") throw new Error("page failed");
          if (fault === "deleted") return [0n, block.timestamp];
          if (fault === "date") return [41n, 1n];
          if (fault === "sum") return [f.held + 1n, block.timestamp];
        }
      }
      return value;
    }) as typeof f.ctx.client.readContract;
    const failed = (await own(f)).assets[0];
    assert.equal(failed.held, f.held, fault); assert.equal(failed.details, null, fault);
    assert.match(failed.detailError!, /Detail unavailable/, fault);
    bad = false; f.calls.length = 0;
    const recovered = (await own(f)).assets[0];
    assert.equal(recovered.detailError, null, fault);
    assert.equal(recovered.details!.claimable, 1275n, fault);
    assert.equal(f.calls.find((c) => c.functionName === "tranche")?.args![1], 0n);
  }
});

test("both sides of the frontier are rechecked and an inconsistent boundary rejects the entire detail", async () => {
  for (const boundaryIndex of [49n, 50n]) {
    const f = fixture(85); let occurrences = 0;
    f.ctx.client.readContract = (async (call: Call) => {
      const value = await f.read(call);
      if (call.functionName === "tranche" && call.args![1] === boundaryIndex && ++occurrences === 2)
        return [boundaryIndex + 1n, boundaryIndex === 49n ? block.timestamp + 101n : block.timestamp];
      return value;
    }) as typeof f.ctx.client.readContract;
    await assert.rejects(summary(f), /inconsistent/);
    assert.equal(occurrences, 2);
  }
});

test("full-book reconciliation is intentionally gone: unread locked rows cannot be audited by this detail", async () => {
  const f = fixture(20_000, 0, 1);
  // A lying provider's held can include an overstatement in an unread locked row. It remains plausible
  // against the subset of rows read: unlike the former full scan, the reader cannot detect it.
  const d = await readGovernanceDetails(f.ctx, vault, zeroAddress, f.held + 1n, block);
  assert.equal(d.claimable, 1n); assert.equal(d.locked, f.held);
  assert.ok(f.calls.length < 25);
});

test("the budget counts actual calls, keeps held, and tells the owner how to reduce an unaffordable matured prefix", async () => {
  const f = fixture(20_000, 0, 400);
  const asset = (await own(f)).assets[0];
  assert.equal(asset.held, f.held); assert.equal(asset.details, null);
  assert.match(asset.detailError!, /matured.*batches of 64/);
  assert.ok(f.calls.length < 30, "reject before reading the expensive prefix");
  const visible = fixture(20_000, 0, 120);
  await assert.rejects(summary(visible, 499), /read budget/);
  assert.equal(visible.calls.length, GOVERNANCE_MAX_READS, "even an optional page cannot exceed the call cap");
  const allMature = fixture(20_000, 0, 20_000);
  assert.equal((await summary(allMature)).claimable, allMature.held);
  assert.equal(allMature.calls.length, 6, "the extreme case never tries to sum 20000 rows");
});

test("one asset's error leaves other requested details and every held intact", async () => {
  const f = fixture(85);
  f.ctx.client.readContract = (async (call: Call) => {
    if (call.functionName === "tranche" && call.args![0] === zeroAddress && call.args![1] === 40n) throw new Error("ETH page failed");
    return f.read(call);
  }) as typeof f.ctx.client.readContract;
  const view = await readGovernance(f.ctx, vault, [{ token: address(10), symbol: "TEST" }], block, owner,
    { [zeroAddress]: null, [address(10)]: null });
  assert.ok(view.assets.every((a) => a.held === f.held));
  assert.equal(view.assets[0].details, null); assert.match(view.assets[0].detailError!, /Detail unavailable/);
  assert.equal(view.assets[1].detailError, null); assert.equal(view.assets[1].details!.claimable, 1275n);
});

test("page helper rejects skipped, repeated and out-of-order indices", async () => {
  for (const index of [39n, 41n, 80n]) await assert.rejects(readTranchePage(40n, 80n, async () => ({ index, amount: 1n, unlockAt: 1n })), /inconsistent/);
  assert.deepEqual(await readTranchePage(80n, 80n, async () => assert.fail()), []);
  await assert.rejects(readTranchePage(-1n, 80n, async () => assert.fail()), /inconsistent/);
});

test("a claim between prefix pages cannot change their block; reorg and hash refusal preserve the public total", async () => {
  const f = fixture(85);
  const shared = await readGovernance(f.ctx, vault, [], block);
  let liveNext = 0n;
  f.ctx.client.readContract = (async (call: Call) => {
    if (call.functionName === "tranche" && call.args![1] === 39n) liveNext = 40n;
    assert.equal(call.blockHash, block.hash);
    return f.read(call); // immutable old book; the live book now has a deleted prefix
  }) as typeof f.ctx.client.readContract;
  const stable = (await readGovernance(f.ctx, vault, [], block, owner, { [zeroAddress]: null }, shared)).assets[0];
  assert.equal(liveNext, 40n); assert.equal(stable.details!.nextTranche, 0n); assert.equal(stable.details!.claimable, 1275n);
  for (const message of ["Block is no longer canonical", "Hash selector unsupported"]) {
    f.ctx.client.readContract = (async (call: Call) => {
      assert.equal(call.blockHash, block.hash); assert.equal(call.requireCanonical, true);
      if (message.includes("unsupported") || call.functionName === "tranche" && call.args![1] === 40n) throw new Error(message);
      return f.read(call);
    }) as typeof f.ctx.client.readContract;
    const a = (await readGovernance(f.ctx, vault, [], block, owner, { [zeroAddress]: null }, shared)).assets[0];
    assert.equal(a.held, f.held); assert.equal(a.details, null); assert.match(a.detailError!, /Detail unavailable/);
  }
  await assert.rejects(readGovernance(f.ctx, vault, [], head(100, 1), owner, {}, shared), /snapshot changed/);
});

test("timeout and cancellation stop a late page from continuing or publishing; another asset still loads", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  for (const cancel of [false, true]) {
    const f = fixture(85), pending = deferred<readonly [bigint, bigint]>(), controller = new AbortController();
    f.ctx.client.readContract = (async (call: Call) => {
      const value = await f.read(call);
      if (call.functionName === "tranche" && call.args![1] === 10n) return pending.promise;
      return value;
    }) as typeof f.ctx.client.readContract;
    const load = summary(f, null, controller.signal);
    const rejected = assert.rejects(load, cancel ? /cancelled/ : /took too long/);
    for (let i = 0; i < 10; i++) await flush();
    assert.ok(f.calls.some((c) => c.functionName === "tranche" && c.args![1] === 10n));
    if (cancel) controller.abort(); else t.mock.timers.tick(GOVERNANCE_DETAIL_MS);
    await rejected;
    const count = f.calls.length;
    pending.resolve([11n, block.timestamp]); await flush();
    assert.equal(f.calls.length, count, "no subsequent page or metadata calls");
    assert.equal((await summary(fixture(20_000, 0, 0))).claimable, 0n, "no deadline shared with other assets");
  }
});
