import assert from "node:assert/strict";
import { test } from "node:test";
import { zeroAddress, type Address } from "viem";
import { readGovernance, type ChildLaunch, type GovernanceView } from "../src/chain/launchpad.ts";
import { CHILD_ROWS, launchpadPage, launchpadReadTargets, mergeLaunchpadLaunches } from "../src/chain/launchpadPage.ts";
import { address, context, hash, head } from "./helpers.ts";

const child = (n: number): ChildLaunch => ({
  token: address(n), hook: address(n + 100), poolId: hash(n), name: `Token ${n}`, symbol: `T${n}`,
  fromBlock: BigInt(n), parent: false, forge: address(1_000), launcher: address(1_001), team: address(1_002),
  fee: 5_000_000_000_000_000n, tx: hash(n + 100),
});

test("without a provisional launch the canonical list is unchanged", () => {
  for (const launches of [[], [child(1)]]) {
    const merged = mergeLaunchpadLaunches(launches, null);
    assert.equal(merged.launches, launches);
    assert.equal(merged.justLaunched, null);
  }
});

test("a provisional launch leads page zero without changing canonical order or losing a row", () => {
  const launches = Object.freeze(Array.from({ length: CHILD_ROWS }, (_, i) => Object.freeze(child(i + 1))));
  const provisional = child(CHILD_ROWS + 1);
  const merged = mergeLaunchpadLaunches(launches, provisional);
  const first = launchpadPage(merged.launches, 0);
  const second = launchpadPage(merged.launches, 1);
  assert.equal(merged.justLaunched, provisional);
  assert.equal(merged.launches.length, launches.length + 1);
  assert.equal(first.pageCount, 2);
  assert.deepEqual(first.tokens, [provisional, ...launches.slice(1).reverse()]);
  assert.deepEqual(second.tokens, [launches[0]]);
  assert.deepEqual([...first.tokens, ...second.tokens], [...launches, provisional].reverse());
});

test("the canonical hook replaces the provisional row and its badge, regardless of address case", () => {
  const provisional = child(10);
  const real = { ...provisional, hook: provisional.hook.toUpperCase() as Address, name: "Canonical name", symbol: "REAL", fromBlock: 11n, tx: hash(200) };
  const launches = Object.freeze([child(1), real, child(12)]);
  const merged = mergeLaunchpadLaunches(launches, provisional);
  assert.equal(merged.launches, launches);
  assert.equal(merged.justLaunched, null);
  assert.equal(merged.launches[1], real, "every field comes from the canonical row");
  assert.deepEqual(launchpadPage(merged.launches, 0).tokens, [launches[2], real, launches[0]]);
  const reorged = mergeLaunchpadLaunches([launches[0]], merged.justLaunched);
  assert.deepEqual(reorged.launches, [launches[0]], "a reconciled provisional row cannot return after a reorg");
});

test("reconciliation uses the hook, not the token address", () => {
  const provisional = child(1);
  const differentHook = { ...provisional, hook: address(999) };
  const merged = mergeLaunchpadLaunches([differentHook], provisional);
  assert.deepEqual(merged.launches, [differentHook, provisional]);
  assert.equal(merged.justLaunched, provisional);
});

test("a provisional launch is visible before the first canonical read", () => {
  const provisional = child(1);
  const merged = mergeLaunchpadLaunches([], provisional);
  const page = launchpadPage(merged.launches, 0);
  assert.equal(merged.launches.length, 1);
  assert.deepEqual(page.tokens, [provisional]);
  assert.equal(page.pageCount, 1);
  assert.deepEqual(launchpadReadTargets([], page.tokens.map((c) => c.hook), provisional.hook), {
    tokens: [], child: null, markets: [],
  });
  assert.equal(mergeLaunchpadLaunches([], null).launches.length, 0);
});

test("an empty selection defaults to the newest visible canonical child", () => {
  const launches = Array.from({ length: CHILD_ROWS + 1 }, (_, i) => child(i + 1));
  for (const selected of [null, ""]) {
    assert.deepEqual(launchpadReadTargets([], [], selected), { tokens: [], child: null, markets: [] });
    for (let page = 0; page < 2; page++) {
      const rows = launchpadPage(launches, page).tokens;
      assert.deepEqual(launchpadReadTargets(launches, rows.map((c) => c.hook), selected), {
        tokens: rows, child: rows[0], markets: rows,
      });
    }
  }
});

test("provisional rows stay out of market and governance reads on every display page", async () => {
  const launches = Object.freeze(Array.from({ length: CHILD_ROWS * 2 }, (_, i) => Object.freeze(child(i + 1))));
  const provisional = child(100);
  const merged = mergeLaunchpadLaunches(launches, provisional);
  const shared: GovernanceView = {
    vault: address(2_000), deployer: address(2_001), lockDuration: 1_000n, lockExtension: 0n, block: head(100),
    assets: [{ token: zeroAddress, symbol: "ETH" }, ...launches].map(({ token, symbol }) => ({
      token, symbol, held: 123n, details: null, detailError: null,
    })),
  };
  const ctx = context({ readContract: async () => assert.fail("Shared governance totals need no RPC reads.") });
  const pages = launchpadPage(merged.launches, 0).pageCount;
  assert.equal(pages, 3);
  for (let page = 0; page < pages; page++) {
    const { tokens: rows } = launchpadPage(merged.launches, page);
    const targets = launchpadReadTargets(launches, rows.map((c) => c.hook), provisional.hook);
    const canonicalRows = rows.filter((c) => c !== provisional);
    assert.deepEqual(targets.tokens, canonicalRows, "governance follows the visible canonical rows across page boundaries");
    assert.deepEqual(targets.markets, canonicalRows, "selecting a provisional token never adds a market read");
    assert.ok(targets.markets.every((c) => launches.includes(c)), "all reads use canonical objects");
    assert.equal(targets.child, null, "a provisional selection never opens another token's swap panel");
    const governance = await readGovernance(ctx, shared.vault, targets.tokens, shared.block, null, {}, shared);
    assert.deepEqual(governance.assets.map((a) => a.token), [zeroAddress, ...canonicalRows.map((c) => c.token)]);
    assert.ok(governance.assets.every((a) => a.held === 123n), "the ETH total and known asset balances remain available");
  }
});

test("canonical selection keeps off-page markets and avoids duplicate reads regardless of case", () => {
  const launches = Array.from({ length: CHILD_ROWS + 1 }, (_, i) => child(i + 1));
  const rows = launchpadPage(launches, 0).tokens;
  const hooks = rows.map((c) => c.hook.toUpperCase());
  const offPage = launchpadReadTargets(launches, hooks, launches[0].hook.toUpperCase());
  assert.deepEqual(offPage.tokens, rows);
  assert.equal(offPage.child, launches[0]);
  assert.deepEqual(offPage.markets, [...rows, launches[0]]);
  assert.equal(offPage.markets.length, CHILD_ROWS + 1);
  const onPage = launchpadReadTargets(launches, hooks, rows[1].hook.toUpperCase());
  assert.equal(onPage.child, rows[1]);
  assert.deepEqual(onPage.markets, rows);
});

test("a provisional selection opens only when its canonical row arrives and closes if removed", () => {
  const provisional = child(10);
  const other = child(1);
  const pending = mergeLaunchpadLaunches([other], provisional);
  const pendingRows = launchpadPage(pending.launches, 0).tokens;
  assert.deepEqual(launchpadReadTargets([other], pendingRows.map((c) => c.hook), provisional.hook), {
    tokens: [other], child: null, markets: [other],
  });
  const canonical = { ...provisional, hook: provisional.hook.toUpperCase() as Address, symbol: "CANONICAL", fromBlock: 20n };
  const launches = [other, canonical];
  const merged = mergeLaunchpadLaunches(launches, provisional);
  const rows = launchpadPage(merged.launches, 0).tokens;
  const targets = launchpadReadTargets(launches, rows.map((c) => c.hook), provisional.hook);
  assert.equal(merged.justLaunched, null);
  assert.equal(targets.child, canonical);
  assert.equal(targets.markets[0], canonical);
  const reorged = mergeLaunchpadLaunches([other], merged.justLaunched);
  assert.deepEqual(launchpadReadTargets([other], reorged.launches.map((c) => c.hook), provisional.hook), {
    tokens: [other], child: null, markets: [other],
  });
});
