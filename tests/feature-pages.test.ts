import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import ts from "typescript";
import { zeroAddress } from "viem";
import { DEPLOYMENT } from "../src/chain/deployment.ts";
import { sameAddress } from "../src/chain/address.ts";
import { PublicData } from "../src/chain/publicData.ts";
import { SCHEMA_VERSION, SNAPSHOT_WARNING_MS, SnapshotClient, stringifyData } from "../src/chain/snapshot.ts";
import type { ChildLaunch, ForgeView, GovernanceView } from "../src/chain/launchpad.ts";
import type { MarketState } from "../src/chain/market.ts";
import type { BlockSnapshot } from "../src/chain/readContext.ts";
import type { VaultView } from "../src/chain/vault.ts";
import { address, context, hash, head } from "./helpers.ts";

// Render the real TSX with the existing Node runner; browser reads and wallets stay local to each render.
const compiled = new Map<string, string>();
function componentModule(file: string, mocks: Record<string, unknown> = {}) {
  const url = new URL(file, import.meta.url);
  let code = compiled.get(file);
  if (!code) {
    code = ts.transpileModule(readFileSync(url, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
      fileName: url.pathname,
    }).outputText;
    compiled.set(file, code);
  }
  const require = createRequire(url);
  const exports: Record<string, React.ComponentType<any>> = {};
  new Function("require", "exports", code)((id: string) => {
    if (id in mocks) return mocks[id];
    return require(id.startsWith(".") ? `${id}.ts` : id);
  }, exports);
  return exports;
}

const deployment = { ...DEPLOYMENT, forge: address(700), governanceVault: address(701) };
// Mainnet before 23 September 2026: the prepared launch record, with no launchpad and no verification arrays.
const prepared = {
  ...DEPLOYMENT, forge: zeroAddress, governanceVault: zeroAddress, governanceDeployer: zeroAddress, hookCreationCodeHash: null,
  launchpadDeployBlock: null, launchpadRuntimeCodeHashes: [], launchpadTransactions: [], runtimeCodeHashes: [],
  launchTransactions: [], launchTimestamp: null,
};
const primitives = componentModule("../src/components/primitives.tsx");
const notice = "Coming soon — This feature is deployed on chain but not activated yet. The team turns it on with a single transaction; nothing activates by itself.";
const block = head(100);
const registeredVault = address(300);
const retiredVault = address(301);
const wallet = address(400);
const unit = 10n ** 18n;
const vault: VaultView = {
  vault: registeredVault, current: true, totalStaked: 1_234n * unit, rewardReserve: 5_678n * unit, totalPaid: 123n * unit,
  lockDuration: 86_400n, dailyRewardBps: 300n, rewardPeriod: 86_400n, block, chainTime: block.timestamp,
  position: { staked: 789n * unit, pending: 23n * unit, unlockAt: 0n, lastRewardAt: 0n, wallet: 456n * unit, allowance: 0n },
};
const child: ChildLaunch = {
  token: address(500), hook: address(501), poolId: hash(500), name: "Existing token", symbol: "EXIST",
  fromBlock: 10n, parent: false, forge: deployment.forge, launcher: wallet, team: wallet,
  fee: 5_000_000_000_000_000n, tx: hash(501),
};
const market: MarketState = {
  ref: child, block: block.number, blockHash: block.hash, timestamp: Number(block.timestamp), sqrtPriceX96: 1n, tick: 0,
  priceWad: unit, priceUnavailable: false, launchSqrtPriceX96: 1n, launchPriceWad: unit,
  band: { lower: 0, upper: 60, liquidity: 1n, eth: unit, cubit: unit }, walls: [], wallEth: unit, wallCubit: 0n,
  activeWalls: 0, partialWalls: 0, crossedWalls: 0, nearestWall: null, nextWall: null,
  pendingFloorEth: 0n, pendingAbsorbedTokens: 0n, teamAccrued: 0n, teamPaidCumulative: 0n,
  team: wallet, sink: deployment.governanceVault, totalSupply: 21_000_000n * unit, totalBurned: 0n,
  registry: null, lens: null, vault: null,
};
const forge: ForgeView = {
  forge: deployment.forge, launchFee: child.fee, launches: 1n, governanceVault: deployment.governanceVault,
  hookCreationCodeHash: hash(502), templateMatches: true, launchEth: unit, poolManager: DEPLOYMENT.poolManager,
};
const governance: GovernanceView = {
  vault: deployment.governanceVault, deployer: address(600), lockDuration: 30n * 86_400n, lockExtension: 0n, block,
  assets: [{ token: zeroAddress, symbol: "ETH", held: unit, details: null, detailError: null }],
};
const history = { events: [], swaps: [], fromBlock: 0n, toBlock: block.number };
function pageStore(active: boolean) {
  return {
    features: { vault: active, momentum: active, forge: active, flags: active ? 13 : 0 },
    modules: { vault: registeredVault, forge: deployment.forge, revision: 1n },
    wallet: "connected", address: wallet, wrongNetwork: false, market, history, series: [], error: null,
    connect: () => assert.fail("A disabled feature must not request a wallet."),
    switchNetwork: () => assert.fail("A disabled feature must not switch networks."), refresh: () => {},
  };
}

type Poll = { load: (block: BlockSnapshot) => Promise<unknown>; interval: number; enabled: boolean };
async function renderPage(page: "Vault" | "Momentum" | "Launchpad", store: ReturnType<typeof pageStore>, data: unknown[], appDeployment = deployment,
  options: { url?: string; vaultPublic?: boolean } = {}) {
  const polls: Poll[] = [];
  const reads: { name: string; args: unknown[] }[] = [];
  const reader = (name: string, result: unknown) => async (...args: unknown[]) => { reads.push({ name, args }); return result; };
  let transactionHooks = 0;
  const mocks = {
    react: { ...React, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() },
    "../Root": { useStore: () => store },
    "../store": { toWall: () => assert.fail("No wall is present in this fixture.") },
    "../components/primitives": primitives,
    "../components/PriceWallChart": { PriceWallChart: () => React.createElement("div", { "data-chart": true }) },
    "../components/SwapWidget": { SwapWidget: () => React.createElement("button", null, "Swap existing token") },
    "../chain/config": {
      CONFIG: appDeployment, sameAddress,
      addressUrl: (a: string) => `${DEPLOYMENT.explorer}/address/${a}`,
      tokenUrl: (a: string) => `${DEPLOYMENT.explorer}/token/${a}`,
      txUrl: (tx: string) => `${DEPLOYMENT.explorer}/tx/${tx}`,
      shortAddress: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
    },
    "../chain/appChain": {
      CUBIT: { ...child, token: DEPLOYMENT.token, hook: DEPLOYMENT.hook, symbol: "CUBIT", parent: true },
      readAllChildren: reader("children", [child]),
      publicData: {
        vault: reader("vault", vault), vaultAddresses: reader("vaultAddresses", [registeredVault, retiredVault]),
        forge: reader("forge", forge), market: reader("market", market), governance: reader("governance", governance),
      },
    },
    "../chain/useRelayAccess": { useRelayAccess: () => {} },
    "../launch": { VAULT_PUBLIC: options.vaultPublic ?? false },
    "../chain/useMarket": { useMarket: () => ({ market, history, error: null }) },
    "../chain/usePoll": {
      usePoll: (load: Poll["load"], _deps: unknown[], interval: number, enabled = true) => {
        const result = data[polls.length] ?? null;
        polls.push({ load, interval, enabled });
        // Disabled polls may still hold the previous render's data until effect cleanup.
        return { data: result, loading: false, error: null, refresh: () => {} };
      },
    },
    "../chain/swap": { approveRequest: () => assert.fail("No approval may be sent by these renders.") },
    "../chain/tx": {
      errorMessage: String,
      useTx: () => {
        transactionHooks++;
        return { phase: "idle", busy: false, slow: false, hash: null, error: null, run: () => assert.fail("No transaction may be sent by these renders.") };
      },
    },
  };
  const Page = componentModule(`../src/pages/${page}.tsx`, mocks)[page];
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [options.url ?? "/"] }, React.createElement(Page)));
  await Promise.all(polls.filter((p) => p.enabled).map((p) => p.load(block)));
  return { html, polls: polls.map(({ interval, enabled }) => ({ interval, enabled })), reads, transactionHooks };
}

const textContent = (html: string) => html.replace(/<[^>]+>/g, "");
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].map((m) => ({ attributes: m[1], label: textContent(m[2]) }));
function assertNotice(html: string) {
  assert.equal(textContent(html).split(notice).length - 1, 1);
}

test("the shared notice keeps the exact text and accepts optional secondary content", () => {
  const plain = renderToStaticMarkup(React.createElement(primitives.ComingSoon));
  assert.equal(textContent(plain), notice);
  assert.match(plain, /role="status"/);
  const secondary = React.createElement("a", { href: "/contract" }, "Registered contract");
  const html = renderToStaticMarkup(React.createElement(primitives.ComingSoon, { secondary }));
  assertNotice(html);
  assert.match(html, /<a href="\/contract">Registered contract<\/a>/);
});

test("the data banner waits for PublicData.warning even with an error or an old snapshot", () => {
  const dataClient = { current: null as { block: BlockSnapshot; producedAt: number } | null, error: null as string | null };
  const publicData = { warning: null as string | null };
  const Banner = componentModule("../src/components/DataAccess.tsx", {
    "../chain/appChain": { dataClient, publicData },
  }).DataAccess;
  const render = () => renderToStaticMarkup(React.createElement(Banner));
  assert.equal(render(), "");
  dataClient.error = "Shared data unavailable. Last snapshot retained.";
  assert.equal(render(), "", "a failed download cannot bypass the grace period");
  dataClient.current = { block, producedAt: 0 };
  assert.equal(render(), "");
  dataClient.error = null;
  assert.equal(render(), "", "an old snapshot cannot bypass the grace period");
  publicData.warning = "Shared snapshot is stale. Using the public RPC for live data.";
  const html = render();
  assert.match(html, /role="status"/);
  assert.ok(textContent(html).includes(publicData.warning));
  assert.ok(textContent(html).includes(`Last shared block ${block.number}`));
  publicData.warning = null;
  assert.equal(render(), "", "clearing the source warning hides the banner immediately");
});

test("the data banner stays absent while closed and clears on both closed responses and shared recovery", async () => {
  let now = 1_200_000, state: "closed" | "failed" | "shared" = "closed";
  const dataClient = new SnapshotClient("https://data.invalid", async () => {
    if (state === "closed") return Response.json({ code: "MARKET_CLOSED" }, { status: 503 });
    if (state === "failed") return new Response(null, { status: 500 });
    return new Response(stringifyData({ schemaVersion: SCHEMA_VERSION, chainId: 1,
      block: { ...block, timestamp: BigInt(Math.floor(now / 1_000)) }, producedAt: now,
      market, registry: {}, children: [], histories: {}, eventTimes: {}, vaults: [], markets: {}, forge: null, governance: null }));
  });
  const direct = context({ getBlock: async () => block });
  const publicData = new PublicData(direct, direct, dataClient, () => now);
  const Banner = componentModule("../src/components/DataAccess.tsx", {
    "../chain/appChain": { dataClient, publicData },
  }).DataAccess;
  const render = () => renderToStaticMarkup(React.createElement(Banner));
  for (const elapsed of [0, 14_400_000]) {
    now += elapsed;
    await publicData.readHead();
    assert.equal(render(), "");
  }
  for (const recovery of ["closed", "shared"] as const) {
    state = "failed";
    await publicData.readHead(); assert.equal(render(), "");
    now += SNAPSHOT_WARNING_MS;
    await publicData.readHead(); assert.equal(render(), "");
    now++;
    await publicData.readHead();
    assert.match(render(), /role="status"/);
    assert.match(render(), /Shared data unavailable/);
    state = recovery;
    const selected = await publicData.readHead();
    assert.equal(selected.source, recovery === "closed" ? "direct" : "shared");
    assert.equal(render(), "", "recovery removes the visible banner immediately");
  }
});

test("an inactive Vault hides funded positions and retired vaults without starting their reads", async () => {
  const store = pageStore(false);
  store.features.momentum = store.features.forge = true;
  const { html, polls, reads, transactionHooks } = await renderPage("Vault", store, [vault, [registeredVault, retiredVault]]);
  assertNotice(html);
  assert.match(html, /The vault\./);
  assert.match(html, /How it works/);
  assert.match(html, /Every new deposit restarts a 24h lock/);
  assert.match(html, new RegExp(`href="${DEPLOYMENT.explorer}/address/${registeredVault}"[^>]*>${registeredVault}`));
  assert.match(html, /withdraw\(\) and claimCubit\(\)/);
  assert.doesNotMatch(html, /Reward reserve|Distributed|Total staked|Your position|Retired vaults|Wallet CUBIT|<input|1,234|5,678/);
  assert.doesNotMatch(html, new RegExp(retiredVault));
  assert.deepEqual(buttons(html).map((b) => b.label), ["Approve &amp; stake", "Withdraw", "Claim rewards", "Compound rewards"]);
  assert.ok(buttons(html).every((b) => /\bdisabled=""/.test(b.attributes)));
  assert.deepEqual(polls, [{ interval: 8_000, enabled: false }, { interval: 60_000, enabled: false }]);
  assert.deepEqual(reads, []);
  assert.equal(transactionHooks, 0);
});

test("an active Vault keeps its data, stake panel, retired vaults and polling intervals", async () => {
  const { html, polls, reads } = await renderPage("Vault", pageStore(true), [vault, [registeredVault, retiredVault], { ...vault, vault: retiredVault, current: false }], deployment, { vaultPublic: true });
  assert.doesNotMatch(html, /Coming soon/);
  assert.match(html, /Reward reserve/);
  assert.match(html, /1,234/);
  assert.match(html, /id="stake-amount"/);
  assert.match(html, /Retired vaults/);
  assert.deepEqual(polls, [{ interval: 8_000, enabled: true }, { interval: 60_000, enabled: true }, { interval: 15_000, enabled: true }]);
  assert.deepEqual(reads.filter((r) => r.name === "vault").map((r) => r.args), [[registeredVault, true, wallet, block], [retiredVault, false, wallet, block]]);
  const claim = buttons(html).find((b) => b.label === "Claim rewards");
  assert.ok(claim && !claim.attributes.includes('disabled=""'));
  // No allowance yet: both deposit buttons announce the approval that goes first.
  assert.ok(buttons(html).some((b) => b.label === "Approve &amp; stake"));
  const compound = buttons(html).find((b) => b.label === "Approve &amp; compound");
  assert.ok(compound && !compound.attributes.includes('disabled=""'), "a claimable reward can be restaked");
  assert.match(html, /Compound restakes what you can claim in one transaction/);
  assert.match(html, /one approval of this vault, with no limit/);
});

test("once the vault is approved, Stake and Compound each need a single transaction", async () => {
  const approved = { ...vault, position: { ...vault.position!, allowance: 2n ** 256n - 1n } };
  const { html } = await renderPage("Vault", pageStore(true), [approved, [registeredVault]], deployment, { vaultPublic: true });
  const labels = buttons(html).map((b) => b.label);
  assert.ok(labels.includes("Stake") && !labels.includes("Approve &amp; stake"));
  const compound = buttons(html).find((b) => b.label === "Compound rewards");
  assert.ok(compound && !compound.attributes.includes('disabled=""'));
});

test("Compound stays disabled while nothing can be claimed", async () => {
  const empty = { ...vault, position: { ...vault.position!, pending: 0n } };
  const { html } = await renderPage("Vault", pageStore(true), [empty, [registeredVault]], deployment, { vaultPublic: true });
  for (const label of ["Claim rewards", "Compound rewards"]) {
    const button = buttons(html).find((b) => b.label === label);
    assert.ok(button && button.attributes.includes('disabled=""'), label);
  }
});

test("before the public launch, a visitor sees Coming soon and no vault figures", async () => {
  const store = { ...pageStore(true), wallet: "disconnected", address: null } as unknown as ReturnType<typeof pageStore>;
  const { html, polls, reads } = await renderPage("Vault", store, [null, null]);
  assert.match(html, /The Vault opens to everyone soon\./);
  assert.match(html, />Coming soon</);
  assert.match(html, />Soon</);
  assert.doesNotMatch(html, /not activated yet/, "the contract is open: the page must not say otherwise");
  assert.doesNotMatch(html, /Reward reserve|Total staked|Claim rewards|Approve &amp; stake|<input/);
  assert.deepEqual(polls, [{ interval: 8_000, enabled: false }, { interval: 60_000, enabled: false }], "no account, no read");
  assert.deepEqual(reads, []);
});

test("before the public launch, an account that already staked keeps Claim, Compound and Withdraw, without deposits", async () => {
  const { html, polls } = await renderPage("Vault", pageStore(true), [vault, null]);
  assert.match(html, /You already have a position: claim, compound or withdraw it below\./);
  const labels = buttons(html).map((b) => b.label);
  for (const label of ["Withdraw", "Claim rewards", "Approve &amp; compound"]) assert.ok(labels.includes(label), label);
  assert.ok(!labels.includes("Approve &amp; stake") && !labels.includes("Stake"), "no new deposit before the launch");
  assert.doesNotMatch(html, /Max wallet|Reward reserve|Retired vaults/);
  assert.deepEqual(polls, [{ interval: 8_000, enabled: true }, { interval: 60_000, enabled: false }]);
});

test("before the public launch, a connected account without a position sees Coming soon only", async () => {
  const empty = { ...vault, position: { ...vault.position!, staked: 0n, pending: 0n } };
  const { html, polls } = await renderPage("Vault", pageStore(true), [empty, null]);
  assert.match(html, /The Vault opens to everyone soon\./);
  assert.doesNotMatch(html, /Claim rewards|Withdraw|already have a position/);
  assert.equal(polls[0].enabled, true, "a connected account is read to find a position it holds");
});

test("?preview shows the full Vault page before the public launch", async () => {
  const { html } = await renderPage("Vault", pageStore(true), [vault, [registeredVault]], deployment, { url: "/vault?preview" });
  assert.match(html, /Live · Ethereum/);
  assert.match(html, /Reward reserve/);
  assert.ok(buttons(html).some((b) => b.label === "Approve &amp; stake"));
  assert.doesNotMatch(html, /opens to everyone soon/);
});

test("the roadmap shows the Vault as Coming soon until its public launch", () => {
  for (const vaultPublic of [false, true]) {
    const Roadmap = componentModule("../src/pages/Roadmap.tsx", {
      "../Root": { useStore: () => pageStore(true) },
      "../components/primitives": primitives,
      "../launch": { VAULT_PUBLIC: vaultPublic },
    }).Roadmap;
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Roadmap)));
    const title = html.indexOf("The Vault");
    const card = html.slice(html.lastIndexOf("Phase 1", title), title);
    assert.match(card, vaultPublic ? />Live</ : />Coming soon</);
  }
});

test("Momentum uses the shared notice only while inactive and keeps its existing read cadence", async () => {
  for (const active of [false, true]) {
    const store = pageStore(true);
    store.features.momentum = active;
    const { html, polls, reads } = await renderPage("Momentum", store, [[child]]);
    assert.match(html, /Momentum\./);
    assert.match(html, /A lens, not a lever\./);
    assert.deepEqual(polls, [{ interval: 30_000, enabled: true }]);
    assert.equal(reads[0].name, "children");
    if (active) {
      assert.doesNotMatch(html, /Coming soon/);
      assert.match(html, /Walls standing/);
      assert.match(html, /data-chart="true"/);
    } else {
      assertNotice(html);
      assert.doesNotMatch(html, /Walls standing|Market price|data-chart|Momentum opens when/);
    }
  }
});

for (const registered of [true, false]) {
  test(`an inactive Launchpad preserves tokens and governance with ${registered ? "a registered Forge" : "no registered Forge"}`, async () => {
    const store = pageStore(true);
    store.features.forge = false;
    if (!registered) store.modules.forge = zeroAddress;
    const { html, polls, reads, transactionHooks } = await renderPage("Launchpad", store, [registered ? forge : null, [child], [{ hook: child.hook, market, error: null }], governance]);
    assertNotice(html);
    assert.ok(html.indexOf("The forge.") < html.indexOf("Coming soon"));
    assert.ok(html.indexOf("Coming soon") < html.indexOf("Launch fee"));
    assert.ok(textContent(html).includes(registered ? "A Forge is registered, but launching is not activated yet." : "No Forge is registered in the registry yet."));
    assert.doesNotMatch(html, /placeholder="My token"|placeholder="MTK"|Launch a token/);
    assert.match(html, /Existing token/);
    assert.match(html, /Held for governance/);
    assert.match(html, /ETH \(launch fees\)/);
    assert.match(html, new RegExp(`href="/momentum\\?token=${child.token}"`));
    const actions = buttons(html);
    assert.ok(actions.find((b) => b.label === "Launch token")?.attributes.includes('disabled=""'));
    assert.ok(actions.some((b) => b.label === "Trade" && !b.attributes.includes('disabled=""')));
    assert.ok(actions.some((b) => b.label === "Swap existing token" && !b.attributes.includes('disabled=""')));
    assert.equal(transactionHooks, 2, "only the child and governance panels mount transaction hooks");
    assert.deepEqual(polls, [
      { interval: 30_000, enabled: registered }, { interval: 15_000, enabled: true },
      { interval: 15_000, enabled: true }, { interval: 15_000, enabled: true },
    ]);
    assert.deepEqual(reads.find((r) => r.name === "market")?.args, [child, block]);
    assert.deepEqual(reads.find((r) => r.name === "governance")?.args, [governance.vault, [child], block, wallet, {}]);
  });
}

test("an active Launchpad keeps the launch form while the other features are inactive", async () => {
  const store = pageStore(false);
  store.features.forge = true;
  const { html, transactionHooks } = await renderPage("Launchpad", store, [forge, [child], [{ hook: child.hook, market, error: null }], governance]);
  assert.doesNotMatch(html, /Coming soon/);
  assert.match(html, /Launch a token/);
  assert.match(html, /placeholder="My token"/);
  assert.match(html, /placeholder="MTK"/);
  assert.match(html, /Existing token/);
  assert.match(html, /Held for governance/);
  assert.equal(transactionHooks, 3);
});

test("mainnet without a launchpad never reads a phantom Forge or governance vault", async () => {
  const store = pageStore(false);
  store.modules.forge = zeroAddress;
  const { html, reads, polls } = await renderPage("Launchpad", store, [null, [], [], null], prepared);
  assert.match(html, /Coming soon/);
  assert.match(html, /launchpad will be added after CUBIT launches/);
  assert.match(html, /No Forge is registered/);
  assert.doesNotMatch(html, /feature is deployed|Testnet|Sepolia/);
  assert.deepEqual(reads.map((r) => r.name), ["children"]);
  assert.deepEqual(polls.map((p) => p.enabled), [false, true, false, false]);
  assert.doesNotMatch(html, /address\/(null|undefined|0x0{40})/);
});

const configMock = {
  CONFIG: DEPLOYMENT, sameAddress,
  addressUrl: (value: string) => `${DEPLOYMENT.explorer}/address/${value}`,
};

test("the CUBIT swap mounts no quote or wallet hooks while closed, loading or unreadable", () => {
  let liveHooks = 0;
  const Swap = componentModule("../src/components/SwapWidget.tsx", {
    "../chain/appChain": { CUBIT: { ...child, parent: true, symbol: "CUBIT" } },
    "../chain/config": configMock, "../store": {},
    "./primitives": primitives,
    "../chain/useSwap": { useSwap: () => { liveHooks++; throw new Error("Live swap mounted"); } },
    "../ui": {},
  }).SwapWidget;
  for (const state of [{ marketOpen: false, error: null }, { marketOpen: null, error: null }, { marketOpen: null, error: "offline" }]) {
    const html = renderToStaticMarkup(React.createElement(Swap, { store: state }));
    assert.equal(liveHooks, 0);
    assert.match(html, /disabled=""/);
    assert.match(html, state.marketOpen === false ? /market is not open yet/ : /Checking market availability/);
    if (state.error) assert.doesNotMatch(html, /Coming soon|market is not open yet|unavailable/);
  }
  assert.throws(() => renderToStaticMarkup(React.createElement(Swap, { store: { marketOpen: true } })), /Live swap mounted/);
  assert.equal(liveHooks, 1, "the live swap returns after launch");
});

test("Proof renders the prepared mainnet record without market data or verification arrays", () => {
  const store = { ...pageStore(false), market: null, marketOpen: false as boolean | null, core: {}, error: null as string | null };
  const Proof = componentModule("../src/pages/Proof.tsx", {
    "../Root": { useStore: () => store }, "../chain/config": { ...configMock, CONFIG: prepared },
    "../chain/appChain": { dataClient: null }, "../components/primitives": primitives,
    "../components/VerifySnapshot": {}, "../components/PriceWallChart": {},
  }).Proof;
  const render = () => renderToStaticMarkup(React.createElement(Proof));
  const html = render();
  assert.match(html, /market is not open yet/);
  for (const value of [DEPLOYMENT.token, DEPLOYMENT.hook, DEPLOYMENT.launch])
    assert.ok(html.includes(`href="https://etherscan.io/address/${value}"`));
  assert.match(html, /Not deployed/);
  assert.doesNotMatch(html, /Sources are verified|one-shot, used|Reading the market|retrying|NaN|undefined/);
  store.marketOpen = null; store.error = "offline";
  assert.match(render(), /Reading the market/);
  assert.doesNotMatch(render(), /market is not open yet|unavailable|retrying/);
});

test("Proof lists the verified mainnet runtimes, each with its Etherscan source", () => {
  const modules = { vault: DEPLOYMENT.vault, router: DEPLOYMENT.router, lens: DEPLOYMENT.lens, forge: DEPLOYMENT.forge, revision: 1n };
  const store = { ...pageStore(false), modules, market: null, marketOpen: false as boolean | null, core: {}, error: null as string | null };
  const Proof = componentModule("../src/pages/Proof.tsx", {
    "../Root": { useStore: () => store }, "../chain/config": configMock,
    "../chain/appChain": { dataClient: null }, "../components/primitives": primitives,
    "../components/VerifySnapshot": {}, "../components/PriceWallChart": {},
  }).Proof;
  const html = renderToStaticMarkup(React.createElement(Proof));
  const hashes = [...DEPLOYMENT.runtimeCodeHashes, ...DEPLOYMENT.launchpadRuntimeCodeHashes];
  assert.equal(hashes.length, 11);
  for (const h of hashes) {
    assert.ok(html.includes(`href="https://etherscan.io/address/${h.address}#code"`), h.contract);
    assert.ok(html.includes(h.keccak256), h.contract);
  }
  assert.ok(html.includes(`href="https://etherscan.io/address/${DEPLOYMENT.governanceVault}"`));
  assert.doesNotMatch(html, /sourcify|Not deployed|Not registered|replaced by the team|hashes are not included/);
});

test("Root shows the market announcement on every route only after a successful closed read", () => {
  const store = { marketOpen: false as boolean | null };
  const Root = componentModule("../src/Root.tsx", {
    "./store": { useProtocolStore: () => store }, "./chain/config": configMock,
    "./components/primitives": primitives, "./components/Header": { Header: () => null },
    "./components/Footer": { Footer: () => null }, "./components/DataAccess": { DataAccess: () => null },
    "./components/RelayAccess": { RelayAccess: () => null },
  }).Root;
  for (const route of ["/", "/proof", "/vault", "/momentum", "/launchpad", "/roadmap"]) {
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [route] }, React.createElement(Root)));
    assert.match(html, /Coming soon/);
    assert.match(html, /contracts are deployed on Ethereum mainnet/);
    assert.match(html, /market is not open yet/);
  }
  store.marketOpen = null;
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Root))), /Coming soon/);
});

test("the protocol store skips market history while closed and keeps its registry features", async () => {
  for (const full of [true, false]) {
    let load!: Poll["load"], data: unknown = null, result: any, error: string | null = null;
    const Store = componentModule("../src/store.ts", {
      "./chain/config": configMock,
      "./chain/appChain": {
        CUBIT: { ...child, parent: true },
        publicData: {
          protocol: async (at: BlockSnapshot, readFull: boolean) => {
            assert.equal(at, block); assert.equal(readFull, full);
            return { marketOpen: false, market: null, registry: { vault: registeredVault, forge: zeroAddress, flags: 0, moduleRevision: 0n }, wallEth: 0n };
          },
          history: () => () => assert.fail("No prelaunch history reads"), snapshot: () => null,
          context: () => ({ client: { getBlock: () => assert.fail("No event timestamps before launch") } }),
        },
      },
      "./chain/wallet": { useWallet: () => ({ status: "disconnected", address: null, chainId: null, error: null, wallets: [] }) },
      "./chain/usePoll": { usePoll: (read: Poll["load"], _deps: unknown[], interval: number) => {
        assert.equal(interval, 30_000); load = read; return { data, error, refresh: () => {} };
      } },
    });
    const useStore = Store.useProtocolStore as unknown as (full: boolean) => unknown;
    const Probe = () => { result = useStore(full); return null; };
    renderToStaticMarkup(React.createElement(Probe));
    assert.equal(result.marketOpen, null);
    data = await load(block);
    renderToStaticMarkup(React.createElement(Probe));
    assert.equal(result.marketOpen, false); assert.equal(result.loading, false); assert.equal(result.error, null);
    assert.equal(result.modules.vault, registeredVault); assert.equal(result.features.flags, 0);
    assert.deepEqual(result.history.events, []);
    data = null; error = "RPC unavailable";
    renderToStaticMarkup(React.createElement(Probe));
    assert.equal(result.marketOpen, null); assert.equal(result.error, error);
  }
});

test("a later read failure disables trading without hiding a pending swap receipt", () => {
  const opened = { current: false }, enabled: boolean[] = [];
  const store = { marketOpen: true as boolean | null, wallet: "connected", core: {}, modules: {}, error: null as string | null };
  const pendingHash = hash(900);
  const Swap = componentModule("../src/components/SwapWidget.tsx", {
    react: { ...React, useRef: () => opened, useEffect: (effect: () => void) => effect() },
    "../chain/appChain": { CUBIT: { ...child, parent: true, symbol: "CUBIT" } },
    "../chain/config": { ...configMock, txUrl: (h: string) => `${DEPLOYMENT.explorer}/tx/${h}` },
    "../store": { CONST: { BUY_TAX: 0.03, SELL_TAX: 0.15 } }, "../ui": { Sparkle: () => null },
    "./primitives": { SlowTransaction: () => null },
    "../chain/useSwap": { useSwap: (options: { enabled: boolean }) => {
      enabled.push(options.enabled);
      return { quote: null, units: 1n, balances: null, tx: { phase: "pending", busy: true, hash: pendingHash } };
    } },
  }).SwapWidget;
  const render = () => renderToStaticMarkup(React.createElement(Swap, { store }));
  assert.match(render(), /Transaction pending/);
  store.marketOpen = null; store.error = "RPC unavailable";
  const failed = render();
  assert.match(failed, /Transaction pending/);
  assert.ok(failed.includes(`https://etherscan.io/tx/${pendingHash}`));
  assert.deepEqual(enabled, [true, false]);
});

test("disabled swaps stop quote, balance and relay demand while preserving transaction state", async () => {
  const polls: boolean[] = [], demands: boolean[] = [];
  const tx = { phase: "pending", hash: hash(901), busy: true };
  const module = componentModule("../src/chain/useSwap.ts", {
    "./appChain": { publicData: {} }, "./config": configMock,
    "./client": { publicClient: {} }, "./swap": {},
    "./wallet": { useWallet: () => ({ status: "connected", address: wallet, chainId: 1 }) },
    "./tx": { useTx: () => tx }, "./useRelayAccess": { useRelayAccess: (enabled: boolean) => demands.push(enabled) },
    "./usePoll": { usePoll: (_load: unknown, _deps: unknown, _interval: number, enabled: boolean) => {
      polls.push(enabled); return { data: null, error: null };
    } },
  });
  let result: any;
  const useSwap = module.useSwap as unknown as (options: unknown) => unknown;
  const Probe = () => {
    result = useSwap({ market: child, router: null, mode: "buy", amount: "0.01", slippage: "1", enabled: false });
    return null;
  };
  renderToStaticMarkup(React.createElement(Probe));
  assert.deepEqual(polls, [false, false]); assert.deepEqual(demands, [false]);
  assert.equal(result.quote, null); assert.equal(result.canSubmit, false); assert.equal(result.tx, tx);
  assert.equal(await result.submit(), false);
});
