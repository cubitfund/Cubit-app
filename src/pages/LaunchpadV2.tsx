// Launchpad v2 — CubitForgeV2: anyone launches a token paired with one of the Forge's quotes (native ETH, or an ERC-20
// such as USDC, USDT, WBTC or a tokenized stock). The Forge accepts taxes chosen by the launcher within fixed bounds;
// they default to CUBIT's own rates (LAUNCH_TAXES: 3% buy, 3% + 12% sell), and every listed token shows its rates.
// The launch fee is paid in ETH to the governance vault, as on the first launchpad. A launch is prepared
// in the browser like script/ForgeV2Launch.s.sol: the hook template is checked against the Forge's frozen hash, a token
// salt is mined so the token sorts above its quote, then the hook salt so the hook address carries its flags. Shown
// only when this build knows a launchpad v2 (src/chain/deployments/1.launchpad-v2.json); the first launchpad's page
// is unchanged.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { useStore } from "../Root";
import { readContext, blockClock, publicData } from "../chain/appChain";
import { readActionBlock } from "../chain/readContext";
import { CONFIG, addressUrl, sameAddress, shortAddress, tokenUrl, txUrl } from "../chain/config";
import { NETWORK } from "../chain/deployment";
import { parseAbi } from "viem";
import { childHookAddress, deliverAbsorbedRequest, hasHookFlags, mineHookSalt, NAME_MAX_BYTES, randomSalt, SYMBOL_MAX_BYTES, utf8Length } from "../chain/launchpad";
import {
  childQuoteHookInitCodeHash, confirmsChildLaunchV2, LAUNCH_TAXES, launchV2Request,
  estimateStillHolds, firstBuyFromSwap, hookCodeFor, isTokenFirst, launchpadV2Configured, mineTokenSalt, parseFirstBuy, parseTaxPercent, quoteAllowance,
  TAX_BOUNDS, taxesValid,
  quoteApproveRequest, readForgeV2,
  type ChildLaunchV2, type ForgeV2View, type LaunchV2Params, type V2Context,
} from "../chain/launchpadV2";
import { type MarketState, type Taxes } from "../chain/market";
import { formatUnitsDec, parseUnitsDec, quotePriceOf, sqrtPriceAtTick, TICK_SPACING, tokensToNumber, unitsToNumber, weiToEth } from "../chain/math";
import { usePoll } from "../chain/usePoll";
import { errorMessage, useTx } from "../chain/tx";
import type { TxStep } from "../chain/txSequence";
import type { WriteRequest } from "../chain/writeRequest";
import { fmtEth, fmtEthAmount, fmtInt, fmtTokens } from "../format";
import { Kpi, Panel, SlowTransaction, StatusTag } from "../components/primitives";
import { SwapWidget } from "../components/SwapWidget";
import { bestEthRoute, describePath } from "../chain/ethRoute";
import { universalRouterEthToQuote, type V3Path } from "../chain/swapEncoding";
import { chainDeadline, tokenBalance } from "../chain/swap";
import { publicClient } from "../chain/client";
import { Cell, FormField, Row } from "./Launchpad";

const v2Context = readContext as unknown as V2Context;
const configured = launchpadV2Configured(CONFIG);

const pct = (bps: number) => `${bps / 100}%`;
const PAGE_SIZE = 12;
/** Sepolia's test quotes (script/mocks/TestQuotes.sol) let anyone mint them. */
const testQuoteAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const taxesLabel = (t: Taxes) => `${pct(t.buyTeamBps)} buy · ${pct(t.sellTeamBps + t.sellWallBps)} sell (${pct(t.sellWallBps)} walls)`;

// ---------------------------------------------------------------------------------------------- pending launches
// Like the first launchpad: a launch keeps its salts until it is seen confirmed, so a second send of the same launch
// collides with the addresses already taken and reverts, instead of paying the launch fee twice.
// A first buy paid with ETH also remembers the pair it bought (`bought`, for `ethIn` wei): a retry after that swap
// reuses it instead of swapping again.
type PendingV2 = {
  key: string; tokenSalt: Hex; hookSalt: Hex | null; token: Address; hook: Address | null; hash: Hex | null; at: number;
  bought?: string; ethIn?: string;
};
// Per Forge: salts mined for one Forge give other addresses on another (a replaced Forge leaves nothing to resume).
const pendingKey = (launcher: Address) => `cubit:pending-launch-v2:${CONFIG.chainId}:${CONFIG.forgeV2.toLowerCase()}:${launcher.toLowerCase()}`;
const identityKey = (p: Omit<LaunchV2Params, "tokenSalt" | "hookSalt" | "buyAmount">) =>
  JSON.stringify([p.name, p.symbol, p.team.toLowerCase(), p.quote.toLowerCase(), p.taxes.buyTeamBps, p.taxes.sellTeamBps, p.taxes.sellWallBps]);
function readPending(launcher: Address): PendingV2[] {
  try { return JSON.parse(localStorage.getItem(pendingKey(launcher)) ?? "[]") as PendingV2[]; } catch { return []; }
}
function writePending(launcher: Address, rows: PendingV2[]) {
  try { localStorage.setItem(pendingKey(launcher), JSON.stringify(rows.slice(-5))); } catch { /* storage refused: no replay guard */ }
}

/** `chooseTaxes`: the launcher sets the token's fees (the /launchpad-custom page); otherwise CUBIT's rates. */
export function LaunchpadV2({ chooseTaxes = false }: { chooseTaxes?: boolean } = {}) {
  const store = useStore();
  const registered = !!store.modules && sameAddress(store.modules.forge, CONFIG.forgeV2);
  const active = registered && store.features.forge;
  // From the data worker's shared snapshot when it carries the launchpad v2, else read directly (publicData).
  const forge = usePoll((block) => publicData.forgeV2(block), [CONFIG.forgeV2], 30_000, configured);
  const children = usePoll(publicData.childrenV2, [CONFIG.forgeV2], 15_000, configured, true);
  const list = useMemo(() => [...(children.data ?? [])].reverse(), [children.data]);
  const [selected, setSelected] = useState<Address | null>(null);
  const child = list.find((c) => sameAddress(c.hook, selected)) ?? null;
  // Every token stays reachable: a search by name, symbol or address, and pages of PAGE_SIZE.
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? list.filter((c) => [c.name, c.symbol, c.token, c.hook, c.quote.symbol].some((v) => v.toLowerCase().includes(needle))) : list;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shownPage = Math.min(page, pages - 1);
  const visible = filtered.slice(shownPage * PAGE_SIZE, shownPage * PAGE_SIZE + PAGE_SIZE);
  // The selected token's market is read even when its row is on another page.
  const reads = child && !visible.some((c) => sameAddress(c.hook, child.hook)) ? [...visible, child] : visible;
  const markets = usePoll(async (block) => {
    const results = await Promise.allSettled(reads.map((c) => publicData.market(c, block)));
    return results.map((r, i) => ({ hook: reads[i].hook, market: r.status === "fulfilled" ? r.value : null,
      error: r.status === "rejected" ? `${reads[i].symbol}: ${errorMessage(r.reason)}` : null }));
  }, [reads.map((c) => c.hook).join()], 15_000, reads.length > 0, true);
  const marketOf = (hook: Address) => markets.data?.find((m) => sameAddress(m.hook, hook))?.market ?? null;
  const refreshAll = () => { children.refresh(); markets.refresh(); forge.refresh(); store.refresh(); };

  if (!configured) return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      <h1 className="font-display text-4xl uppercase">Launchpad v2</h1>
      <p className="mt-4 font-mono text-[13px] text-ink/75">This build does not know a launchpad v2. <Link className="underline" to="/launchpad-v1">Open the first launchpad</Link>.</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b-[3px] border-ink pb-6">
        <div>
          <StatusTag tone={active ? "live" : "next"}>{active ? "Live · public" : registered ? "Registered · not active" : "Not registered"}</StatusTag>
          <h1 className="mt-3 font-display text-4xl uppercase leading-[0.9] md:text-7xl">The forge v2.</h1>
          <p className="mt-4 max-w-2xl font-mono text-[13px] leading-relaxed text-ink/75">
            {chooseTaxes
              ? "Launch a token paired with ETH, a stablecoin, WBTC or a tokenized stock, and choose its fees: what buys and sales pay to your team, and what sales put in the walls. "
              : "Launch a token paired with ETH, a stablecoin, WBTC or a tokenized stock, with CUBIT's taxes. "}
            Every token runs CUBIT's market maker in its own pool — its own band, its own walls, held in its pair.
          </p>
        </div>
        <Link to="/launchpad-v1" className="brutal bg-cream px-3 py-2 font-mono text-[11px] font-bold uppercase">First launchpad · governance vault →</Link>
      </div>

      <div className="grid grid-cols-2 border-[3px] border-ink lg:grid-cols-4">
        <div className="border-b-[3px] border-r-[3px] border-ink lg:border-b-0"><Kpi label="Launch fee" value={forge.data ? `${fmtEthAmount(weiToEth(forge.data.launchFee))} ETH` : "—"} unit="paid to governance · not refunded" /></div>
        <div className="border-b-[3px] border-ink lg:border-b-0 lg:border-r-[3px]"><Kpi label="Tokens launched" value={children.data ? fmtInt(children.data.length) : "—"} unit="on this launchpad" accent="#5b4bff" /></div>
        <div className="border-r-[3px] border-ink"><Kpi label="Pairs" value={forge.data ? fmtInt(forge.data.quotes.length) : "—"} unit={forge.data ? forge.data.quotes.map((q) => q.symbol).join(" · ") : ""} accent="#7a9e00" /></div>
        <div><Kpi label="Governance vault" value={forge.data ? shortAddress(forge.data.governanceVault) : "—"} unit="receives every launch fee" /></div>
      </div>
      {(forge.error || children.error) && <p role="alert" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-orange">Launchpad v2 data unavailable: {forge.error ?? children.error}</p>}

      <div className="mt-10 grid gap-8 lg:grid-cols-3 [&>*]:min-w-0">
        <div className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-xs font-bold uppercase tracking-widest">Launched tokens{list.length > 0 ? ` · ${fmtInt(list.length)}` : ""}</h2>
            <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder="Search name, symbol or address"
              aria-label="Search launched tokens" className="w-64 border-[2px] border-ink bg-cream px-2 py-1 font-mono text-[11px]" />
          </div>
          <Panel>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left font-mono text-[11px] tabular-nums">
                <thead>
                  <tr className="border-b-[2px] border-ink text-[9px] uppercase tracking-widest text-ink/50">
                    <th className="px-4 py-2 font-normal">Token</th>
                    <th className="px-4 py-2 font-normal">Pair</th>
                    <th className="px-4 py-2 text-right font-normal">Price</th>
                    <th className="px-4 py-2 text-right font-normal">vs launch</th>
                    <th className="px-4 py-2 text-right font-normal">In walls</th>
                    <th className="px-4 py-2 font-normal">Taxes</th>
                    <th className="px-4 py-2 text-right font-normal" />
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-ink/45">{children.loading ? "Reading the launches…" : needle ? "No token matches this search." : "No token launched yet."}</td></tr>}
                  {visible.map((c) => <ChildRowV2 key={c.hook} child={c} market={marketOf(c.hook)} selected={sameAddress(selected, c.hook)} onTrade={() => setSelected(c.hook)} />)}
                </tbody>
              </table>
            </div>
          </Panel>
          {pages > 1 && (
            <div className="mt-2 flex items-center justify-end gap-2 font-mono text-[10px] uppercase tracking-widest">
              <button disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)} className="border-[2px] border-ink px-2 py-1 disabled:opacity-40">← Newer</button>
              <span>Page {shownPage + 1} / {pages}</span>
              <button disabled={shownPage >= pages - 1} onClick={() => setPage(shownPage + 1)} className="border-[2px] border-ink px-2 py-1 disabled:opacity-40">Older →</button>
            </div>
          )}
          {markets.data?.filter((m) => m.error).map((m) => <p role="alert" key={m.hook} className="mt-2 font-mono text-[10px] text-orange">Market unavailable: {m.error}</p>)}
        </div>
        <LaunchFormV2 store={store} forge={forge.data} active={active} chooseTaxes={chooseTaxes} onLaunched={(hook) => { if (hook) setSelected(hook); refreshAll(); }} />
      </div>

      {child && <ChildPanelV2 key={child.hook} store={store} child={child} market={marketOf(child.hook)} onDone={refreshAll} />}
    </div>
  );
}

function LaunchFormV2({ store, forge, active, chooseTaxes, onLaunched }: {
  store: ReturnType<typeof useStore>; forge: ForgeV2View | null; active: boolean; chooseTaxes: boolean; onLaunched: (hook?: Address) => void;
}) {
  const account = store.wallet === "connected" ? store.address : null;
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [team, setTeam] = useState("");
  const [quote, setQuote] = useState<Address>(zeroAddress);
  const [buy, setBuy] = useState("");
  // The token's fees, in percent, when the launcher chooses them (CUBIT's rates to start from).
  const [buyTax, setBuyTax] = useState(String(LAUNCH_TAXES.buyTeamBps / 100));
  const [sellTeamTax, setSellTeamTax] = useState(String(LAUNCH_TAXES.sellTeamBps / 100));
  const [sellWallTax, setSellWallTax] = useState(String(LAUNCH_TAXES.sellWallBps / 100));
  // The first buy of an ERC-20 pair can be paid with ETH: swapped to the pair on Uniswap v3 just before the launch.
  const [buyWithEth, setBuyWithEth] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ token: Address; hook: Address; symbol: string } | null>(null);
  const prepared = useRef<{ forge: Address; token: Address; hook: Address; params: LaunchV2Params; fee: bigint; creationCode: Hex; ethIn?: bigint; route?: V3Path } | null>(null);
  const tx = useTx((receipt) => {
    const p = prepared.current;
    if (receipt && p && confirmsChildLaunchV2(receipt, p)) {
      if (account) writePending(account, readPending(account).filter((r) => r.key !== identityKey(p.params)));
      onLaunched(p.hook);
    } else { setLaunched(null); onLaunched(); }
  });
  useEffect(() => { if (forge && !forge.quotes.some((q) => q.address === quote)) setQuote(forge.quotes[0]?.address ?? zeroAddress); }, [forge, quote]);

  const option = forge?.quotes.find((q) => q.address === quote) ?? null;
  // The launcher's rates when this page lets them choose, CUBIT's own rates otherwise.
  const taxes: Taxes = chooseTaxes
    ? { buyTeamBps: parseTaxPercent(buyTax), sellTeamBps: parseTaxPercent(sellTeamTax), sellWallBps: parseTaxPercent(sellWallTax) }
    : LAUNCH_TAXES;
  const taxesOk = taxesValid(taxes);
  const cleanName = name.trim();
  const cleanSymbol = symbol.trim();
  const teamAddress = team.trim() || account || "";
  const nameBytes = utf8Length(cleanName);
  const symbolBytes = utf8Length(cleanSymbol);
  // Addresses that could never pass the taxes on (the Forge refuses the first four); the pair itself would hold them
  // forever too.
  const blocked = [CONFIG.hook, CONFIG.forgeV2, CONFIG.poolManager, forge?.governanceVault ?? zeroAddress, ...(option && option.address !== zeroAddress ? [option.address] : [])];
  const teamValid = isAddress(teamAddress) && teamAddress !== zeroAddress && !blocked.some((a) => sameAddress(a, teamAddress));
  const ethPair = !!option && option.address !== zeroAddress;
  const payEth = ethPair && buyWithEth;
  // In the pair's units, or in wei when the first buy is paid with ETH.
  const firstBuy = option ? parseFirstBuy(buy, payEth ? 18 : option.decimals) : { units: 0n, invalid: false };
  const buyUnits = firstBuy.units;
  const ethRoute = useEthRouteEstimate(payEth ? option!.address : null, payEth ? buyUnits : 0n);
  // What the launch spends: the fee in ETH, plus the first buy in ETH (paid with ETH or an ETH pair) or in the pair.
  const balances = usePoll(async (block) => ({
    key: `${account}:${option?.address}`,
    eth: await publicClient.getBalance({ address: account!, blockNumber: block.number }),
    pair: ethPair ? await tokenBalance(option!.address, account!, block.number) : 0n,
  }), [account, option?.address], 12_000, !!account && !!option);
  const held = balances.data?.key === `${account}:${option?.address}` ? balances.data : null;
  const needEth = (forge?.launchFee ?? 0n) + (payEth || !ethPair ? buyUnits : 0n);
  const needPair = ethPair && !payEth ? buyUnits : 0n;
  const shortEth = !!held && held.eth < needEth;
  const shortPair = !!held && held.pair < needPair;
  const valid = nameBytes > 0 && nameBytes <= NAME_MAX_BYTES && symbolBytes > 0 && symbolBytes <= SYMBOL_MAX_BYTES && teamValid && !!option &&
    !firstBuy.invalid;

  const launch = async () => {
    if (!account || !forge || !option) return;
    const identity = { name: cleanName, symbol: cleanSymbol, team: teamAddress as Address, quote: option.address, taxes };
    const key = identityKey(identity);
    const saved = readPending(account).find((r) => r.key === key) ?? null;
    const shown = payEth && buyUnits > 0n ? ethRoute?.out ?? null : null;
    prepared.current = null;
    setLaunched(null);
    setProgress(null);
    const steps: TxStep<WriteRequest>[] = [{
      label: "Preparing the launch",
      request: async (check) => {
        const block = await readActionBlock(readContext, () => blockClock.refresh(), check);
        check();
        const f = await readForgeV2(v2Context, block);
        check();
        if (!f.templateMatches) throw new Error("The Forge's hook template differs from this app's build. Reload the app.");
        const q = f.quotes.find((x) => x.address === identity.quote);
        if (!q) throw new Error("This pair is no longer offered by the Forge.");
        // A v3 Forge puts an ERC-20 pair's token first: its own hook template, and a token address under the pair.
        const creationCode = hookCodeFor(v2Context.config, f, q.address);
        const below = isTokenFirst(f, q.address);
        // The token salt must give an address on the right side of the quote; the same launch keeps its first salts.
        const minedToken = saved
          ? { salt: saved.tokenSalt, token: saved.token, tries: 0 }
          : await mineTokenSalt(v2Context, f.forge, account, identity.name, identity.symbol, q.address, BigInt(randomSalt()), () => { try { check(); return false; } catch { return true; } }, below);
        check();
        const code = await readContext.client.getCode({ address: minedToken.token });
        check();
        if (saved && code && code !== "0x") {
          writePending(account, readPending(account).filter((r) => r.key !== key));
          throw new Error("That launch already went through: this token exists and its fee is paid. Nothing to send.");
        }
        const initCodeHash = childQuoteHookInitCodeHash(creationCode, f.poolManager, minedToken.token, identity.team, q.address, q.launchValue, identity.taxes);
        const kept = saved?.hookSalt ? childHookAddress(f.forge, account, saved.hookSalt, initCodeHash) : null;
        const minedHook = kept && hasHookFlags(kept)
          ? { salt: saved!.hookSalt!, hook: kept, tries: 0 }
          : await mineHookSalt(readContext, f.forge, account, initCodeHash, (tries) => { check(); setProgress(`Mining the hook address · ${fmtInt(tries)} salts tried`); }, () => { try { check(); return false; } catch { return true; } });
        check();
        writePending(account, [...readPending(account).filter((r) => r.key !== key),
          { key, tokenSalt: minedToken.salt, hookSalt: minedHook.salt, token: minedToken.token, hook: minedHook.hook, hash: null, at: Date.now(),
            bought: saved?.bought, ethIn: saved?.ethIn }]);
        // Paid with ETH: the Forge pulls exactly the route's output less 1%, the swap's floor; any excess stays in the
        // wallet, in the pair.
        let buyAmount = buyUnits;
        let route: V3Path | undefined;
        const keptBuy = payEth && saved?.bought && saved.ethIn === buyUnits.toString() ? BigInt(saved.bought) : null;
        if (keptBuy !== null && await tokenBalance(q.address, account) >= keptBuy) {
          // This launch's swap already went through: its pair is reused, never bought twice.
          check();
          buyAmount = keptBuy;
          setProgress(`Reusing the ${formatUnitsDec(keptBuy, q.decimals, 6)} ${q.symbol} already bought for this launch`);
        } else if (payEth && buyUnits > 0n) {
          // Quoted now, after the salt mining, and held to the estimate the user saw.
          const best = await bestEthRoute(readContext.client as never, CONFIG, q.address, buyUnits);
          check();
          if (!best) throw new Error(`No Uniswap route from ETH to ${q.symbol}. Pay the first buy in ${q.symbol} instead.`);
          if (shown !== null && !estimateStillHolds(shown, best.out)) {
            throw new Error(`The ${q.symbol} price moved since the estimate (≈ ${formatUnitsDec(shown, q.decimals, 6)} → ${formatUnitsDec(best.out, q.decimals, 6)}). Check the new estimate and launch again.`);
          }
          buyAmount = firstBuyFromSwap(best.out);
          route = best.path;
        }
        const params: LaunchV2Params = { ...identity, tokenSalt: minedToken.salt, hookSalt: minedHook.salt, buyAmount };
        prepared.current = { forge: f.forge, token: minedToken.token, hook: minedHook.hook, params, fee: f.launchFee, creationCode,
          ethIn: route ? buyUnits : undefined, route };
        setProgress(`Token address ${below ? "below" : "above"} ${q.symbol} and hook address found`);
        setLaunched({ token: minedToken.token, hook: minedHook.hook, symbol: identity.symbol });
        return null;
      },
    }];
    // An ERC-20 buy is pulled by the Forge: an exact allowance, reset to zero first when USDT would refuse the change.
    const erc20Buy = buyUnits > 0n && option.address !== zeroAddress;
    if (erc20Buy && payEth) {
      steps.push({
        label: `Swap ETH to ${option.symbol}`,
        request: async (check) => {
          // A fresh swap, even when the wallet already holds the pair: paying with ETH never spends the launcher's
          // own pair. Skipped only when this launch's earlier swap is reused.
          const p = prepared.current!;
          if (!p.route) return null;
          const deadline = await chainDeadline();
          check();
          return universalRouterEthToQuote(CONFIG.universalRouter, p.route!, p.ethIn!, p.params.buyAmount, deadline);
        },
      });
    }
    if (erc20Buy) {
      steps.push({
        label: `Reset the ${option.symbol} allowance`,
        request: async () => {
          const p = prepared.current!;
          // Reached only once the swap confirmed: remember what it bought, for a retry.
          if (p.route && p.ethIn !== undefined) {
            writePending(account, readPending(account).map((r) => (r.key === key ? { ...r, bought: p.params.buyAmount.toString(), ethIn: p.ethIn!.toString() } : r)));
          }
          const current = await quoteAllowance(v2Context, option.address, account, p.forge);
          // Exactly the buy: a larger allowance left from an earlier attempt is brought back down too.
          return current > 0n && current !== p.params.buyAmount ? quoteApproveRequest(option.address, p.forge, 0n) : null;
        },
      });
      steps.push({
        label: `Approve ${option.symbol} for the launch buy`,
        request: async () => {
          const current = await quoteAllowance(v2Context, option.address, account, prepared.current!.forge);
          const need = prepared.current!.params.buyAmount;
          return current === need ? null : quoteApproveRequest(option.address, prepared.current!.forge, need);
        },
      });
    }
    steps.push({
      label: "Launch",
      request: async () => {
        const p = prepared.current!;
        return launchV2Request(p.forge, p.fee, p.params, p.creationCode);
      },
    });
    const ok = await tx.run(steps);
    if (ok) { setName(""); setSymbol(""); setBuy(""); } else setLaunched(null);
  };

  let label = "Launch token";
  let action: () => void = () => void launch();
  let disabled = false;
  if (store.wallet === "connecting") [label, disabled] = ["Connecting…", true];
  else if (store.wallet !== "connected") [label, action] = ["Connect wallet to launch", () => store.connect()];
  else if (store.wrongNetwork) [label, action] = [`Switch to ${CONFIG.chainName}`, store.switchNetwork];
  else if (!active) [label, disabled] = ["Launchpad v2 not active", true];
  else if (tx.phase === "working") [label, disabled] = [progress ?? `${tx.label ?? "Preparing"}…`, true];
  else if (tx.phase === "signing") [label, disabled] = ["Confirm in your wallet…", true];
  else if (tx.phase === "pending") [label, disabled] = [tx.slow ? "Still pending…" : "Launch pending…", true];
  else if (tx.phase === "success") [label, disabled] = [launched ? "Launched ✓" : "Transaction confirmed", true];
  else if (!valid) [label, disabled] = ["Fill in the token", true];
  else if (!taxesOk) [label, disabled] = ["Fees out of bounds", true];
  else if (firstBuy.invalid) [label, disabled] = ["Check the first buy amount", true];
  else if (!held) [label, disabled] = ["Reading your balance…", true];
  else if (shortEth) [label, disabled] = [`Not enough ${CONFIG.chainName} ETH: ${formatUnitsDec(held.eth, 18, 6)} held, ${formatUnitsDec(needEth, 18, 6)} + gas needed`, true];
  else if (shortPair) [label, disabled] = [`Not enough ${option!.symbol}: ${formatUnitsDec(held.pair, option!.decimals, 6)} held`, true];
  else if (forge && !forge.templateMatches) [label, disabled] = ["Template mismatch", true];

  return (
    <Panel className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest">Launch a token</h2>
        <StatusTag tone={active ? "live" : "muted"}>{active ? "Open" : "Closed"}</StatusTag>
      </div>
      <FormField label="Name" hint={`${nameBytes}/${NAME_MAX_BYTES} bytes`} value={name} onChange={setName} placeholder="My token" invalid={nameBytes > NAME_MAX_BYTES} />
      <FormField label="Symbol" hint={`${symbolBytes}/${SYMBOL_MAX_BYTES} bytes`} value={symbol} onChange={setSymbol} placeholder="MTK" invalid={symbolBytes > SYMBOL_MAX_BYTES} />
      <FormField label="Team address (receives the token's team taxes, in its pair)" hint={team ? (teamValid ? "valid" : "invalid") : "default: your wallet"} value={team} onChange={setTeam} placeholder={account ?? "0x…"} invalid={!!team && !teamValid} />
      <label className="mb-3 block">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink/60">Pair</span>
        <select value={quote} onChange={(e) => setQuote(e.target.value as Address)} className="w-full border-[2px] border-ink bg-cream px-2 py-2 font-mono text-xs">
          {(forge?.quotes ?? []).map((q) => <option key={q.address} value={q.address}>{q.symbol}</option>)}
        </select>
      </label>
      {chooseTaxes && (
        <div className="mb-3 border-[2px] border-dashed border-ink/40 p-3">
          <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest">Your token's fees · frozen at launch</p>
          <div className="grid grid-cols-3 gap-2">
            <FormField label={`Buy → your team (0–${TAX_BOUNDS.buyTeamBps / 100}%)`} hint="%" value={buyTax} onChange={setBuyTax} placeholder="3"
              invalid={!Number.isFinite(taxes.buyTeamBps) || taxes.buyTeamBps > TAX_BOUNDS.buyTeamBps} />
            <FormField label={`Sell → your team (0–${TAX_BOUNDS.sellTeamBps / 100}%)`} hint="%" value={sellTeamTax} onChange={setSellTeamTax} placeholder="3"
              invalid={!Number.isFinite(taxes.sellTeamBps) || taxes.sellTeamBps > TAX_BOUNDS.sellTeamBps} />
            <FormField label={`Sell → walls (0–${TAX_BOUNDS.sellWallBps / 100}%)`} hint="%" value={sellWallTax} onChange={setSellWallTax} placeholder="12"
              invalid={!Number.isFinite(taxes.sellWallBps) || taxes.sellWallBps > TAX_BOUNDS.sellWallBps} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wide text-ink/60">
            <span>Sale total {Number.isFinite(taxes.sellTeamBps + taxes.sellWallBps) ? pct(taxes.sellTeamBps + taxes.sellWallBps) : "—"} (max {TAX_BOUNDS.sellTotalBps / 100}%)</span>
            <button type="button" className="underline" onClick={() => { setBuyTax("3"); setSellTeamTax("3"); setSellWallTax("12"); }}>CUBIT's rates (3 / 3 / 12)</button>
          </div>
          {taxesOk && taxes.sellWallBps === 0 && <p className="mt-2 font-mono text-[10px] uppercase text-orange">With 0% to the walls, this token's sales fund no walls: nothing supports its price.</p>}
          <p className="mt-2 font-mono text-[10px] normal-case text-ink/55">The launch fee (0.005 ETH to CUBIT governance) is not a fee you choose. Once launched, these rates can never change.</p>
        </div>
      )}
      {NETWORK === "sepolia" && option && option.address !== zeroAddress && account && <TestFaucet quote={option} account={account} />}
      {ethPair && (
        <div className="mb-2 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink/55">Pay the first buy with</span>
          {([true, false] as const).map((eth) => (
            <button key={String(eth)} onClick={() => { if (eth !== buyWithEth) setBuy(""); setBuyWithEth(eth); }} aria-pressed={buyWithEth === eth}
              className={`border-[2px] border-ink px-2 py-1 font-mono text-[10px] font-bold uppercase ${buyWithEth === eth ? "bg-ink text-cream" : "bg-transparent text-ink"}`}>
              {eth ? "ETH" : option!.symbol}
            </button>
          ))}
        </div>
      )}
      <FormField label={`Your first buy, in ${payEth ? "ETH" : option?.symbol ?? "the pair"} (optional)`} hint={payEth ? "18 decimals" : option ? `${option.decimals} decimals` : ""} value={buy} onChange={setBuy} placeholder="0" invalid={firstBuy.invalid} />
      {held && (
        <p className="-mt-2 mb-3 font-mono text-[10px] uppercase tracking-widest text-ink/55">
          Balance · {formatUnitsDec(held.eth, 18, 6)} ETH{ethPair && <> · {formatUnitsDec(held.pair, option!.decimals, 6)} {option!.symbol}</>}
        </p>
      )}
      {payEth && buyUnits > 0n && (
        <p className="-mt-2 mb-3 font-mono text-[10px] uppercase tracking-wide text-ink/60">
          {ethRoute === undefined ? "Finding a route…" : ethRoute === null ? `No Uniswap route from ETH to ${option!.symbol}: pay in ${option!.symbol}.`
            : `≈ ${formatUnitsDec(ethRoute.out, option!.decimals, 6)} ${option!.symbol} via ${describePath(ethRoute.path, { [CONFIG.weth.toLowerCase()]: "ETH", [CONFIG.routeHub.toLowerCase()]: "USDC", [option!.address.toLowerCase()]: option!.symbol })}. The launch buys with 99% of it; the rest stays in your wallet.`}
        </p>
      )}

      <div className="mb-4 space-y-1.5 border-l-[3px] border-ink/20 pl-3 font-mono text-[10px] uppercase tracking-wide text-ink/70">
        <Row l="Launch fee" r={forge ? `${fmtEthAmount(weiToEth(forge.launchFee))} ETH + gas` : "—"} />
        <Row l="The fee goes to" r="CUBIT governance · not refunded" />
        <Row l="Supply" r="21,000,000 · all in the band" />
        <Row l="Launch valuation" r={option ? `${formatUnitsDec(option.launchValue, option.decimals, 6)} ${option.symbol} FDV` : "—"} />
        <Row l="Taxes, frozen at launch" r={taxesOk ? taxesLabel(taxes) : "out of bounds"} />
        <Row l="Hook template" r={forge ? (forge.templateMatches ? "matches the Forge ✓" : "mismatch") : "—"} accent={forge?.templateMatches ? "#7a9e00" : undefined} />
      </div>

      <button onClick={action} disabled={disabled}
        className={`brutal brutal-lift w-full py-3 font-mono text-[12px] font-bold uppercase tracking-widest disabled:cursor-not-allowed ${tx.phase === "success" ? "bg-lime text-ink" : disabled ? "bg-ink/15 text-ink/55" : "bg-violet text-cream"}`}>
        {label}
      </button>
      {progress && tx.phase !== "idle" && tx.phase !== "error" && <p role="status" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-ink/70">{progress}</p>}
      <SlowTransaction tx={tx} className="mt-3" />
      {launched && (
        <div className="mt-3 space-y-1 border-l-[3px] border-lime bg-lime/15 px-3 py-2 font-mono text-[10px] uppercase tracking-wide">
          <p>{tx.phase === "success" ? "Launched" : "Launching"} {launched.symbol}</p>
          <p className="break-all normal-case">token <a className="underline" href={tokenUrl(launched.token)} target="_blank" rel="noreferrer">{launched.token}</a></p>
          <p className="break-all normal-case">hook <a className="underline" href={addressUrl(launched.hook)} target="_blank" rel="noreferrer">{launched.hook}</a></p>
        </div>
      )}
      {tx.error && <p role="alert" className="mt-3 break-words font-mono text-[10px] uppercase tracking-wide text-orange">{tx.error}</p>}
      {tx.hash && <a href={txUrl(tx.hash)} target="_blank" rel="noreferrer" className="mt-2 block font-mono text-[10px] uppercase tracking-widest text-violet underline">View transaction ↗</a>}
    </Panel>
  );
}

/** Sepolia only: mint test units of a test quote to the connected wallet, to launch or buy with it. */
function TestFaucet({ quote, account }: { quote: { address: Address; symbol: string; decimals: number }; account: Address }) {
  const tx = useTx(() => undefined);
  const amount = quote.decimals >= 8 && quote.symbol === "WBTC" ? 1n : 10_000n;
  return (
    <div className="mb-3 flex items-center gap-3 border-l-[3px] border-violet bg-violet/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wide">
      <span>Sepolia test token</span>
      <button type="button" disabled={tx.busy}
        onClick={() => void tx.run([{ label: `Mint test ${quote.symbol}`, request: async () => ({
          address: quote.address, abi: testQuoteAbi, functionName: "mint", args: [account, amount * 10n ** BigInt(quote.decimals)],
        }) }])}
        className="brutal bg-lime px-2 py-1 font-bold uppercase disabled:opacity-40">
        {tx.phase === "success" ? "Minted ✓" : `Get ${amount.toLocaleString("en-US")} test ${quote.symbol}`}
      </button>
      {tx.error && <span role="alert" className="text-orange">{tx.error}</span>}
    </div>
  );
}

function priceOf(market: MarketState | null, child: ChildLaunchV2) {
  if (!market || market.priceUnavailable) return null;
  return quotePriceOf(market.sqrtPriceX96, child.quote.decimals, child.tokenFirst);
}

function ChildRowV2({ child, market, selected, onTrade }: { child: ChildLaunchV2; market: MarketState | null; selected: boolean; onTrade: () => void }) {
  const price = priceOf(market, child);
  const launch = market ? quotePriceOf(market.launchSqrtPriceX96, child.quote.decimals, child.tokenFirst) : null;
  return (
    <tr className={`border-b border-dashed border-ink/25 last:border-b-0 ${selected ? "bg-lime/15" : ""}`}>
      <td className="px-4 py-3">
        <a href={tokenUrl(child.token)} target="_blank" rel="noreferrer" className="font-bold underline hover:text-violet">{child.symbol}</a>
        <span className="ml-2 text-ink/55">{child.name}</span>
      </td>
      <td className="px-4 py-3">{child.quote.symbol}</td>
      <td className="px-4 py-3 text-right">{price === null ? "—" : `${fmtEth(price)} ${child.quote.symbol}`}</td>
      <td className="px-4 py-3 text-right">{price !== null && launch ? `${(price / launch).toFixed(2)}×` : "—"}</td>
      <td className="px-4 py-3 text-right">{market ? `${fmtEthAmount(unitsToNumber(market.wallEth, child.quote.decimals))} ${child.quote.symbol}` : "—"}</td>
      <td className="px-4 py-3 text-ink/70">{taxesLabel(child.taxes)}</td>
      <td className="px-4 py-3 text-right"><button onClick={onTrade} className="brutal bg-violet px-2 py-1 text-[10px] font-bold uppercase text-cream">Trade</button></td>
    </tr>
  );
}

function ChildPanelV2({ store, child, market, onDone }: { store: ReturnType<typeof useStore>; child: ChildLaunchV2; market: MarketState | null; onDone: () => void }) {
  const tx = useTx(onDone);
  const q = child.quote;
  const price = priceOf(market, child);
  const nextWall = market?.nextWall
    // A wall's highest price: its lower tick for a quote-first pool, its upper tick for a token-first one.
    ? { level: quotePriceOf(sqrtPriceAtTick(market.nextWall.lower + (child.tokenFirst ? TICK_SPACING : 0)), q.decimals, child.tokenFirst),
      underMarket: market.nextWall.underMarket } : null;
  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-3 [&>*]:min-w-0">
      <div className="lg:col-span-2">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">{child.symbol} — {child.name} · paired with {q.symbol}</h2>
        <div className="grid grid-cols-2 border-[3px] border-ink md:grid-cols-3">
          <Cell label="Market price" value={price === null ? "—" : fmtEth(price)} unit={q.symbol} />
          <Cell label="FDV" value={price === null || !market ? "—" : fmtEthAmount(price * tokensToNumber(market.totalSupply))} unit={q.symbol} />
          <Cell label={`${q.symbol} in walls`} value={market ? fmtEthAmount(unitsToNumber(market.wallEth, q.decimals)) : "—"} unit={market ? `${market.activeWalls + market.partialWalls} standing` : ""} />
          <Cell label="Band" value={market ? fmtTokens(tokensToNumber(market.band.cubit)) : "—"} unit={market ? `${child.symbol} · ${fmtEthAmount(unitsToNumber(market.band.eth, q.decimals))} ${q.symbol}` : ""} />
          <Cell label="Pending wall funds" value={market ? fmtEthAmount(unitsToNumber(market.pendingFloorEth, q.decimals)) : "—"} unit={q.symbol} />
          <Cell label="Taxes, frozen at launch" value={taxesLabel(child.taxes)} unit="" />
        </div>
        <div className="mt-4 space-y-1.5 font-mono text-[10px] uppercase tracking-wide text-ink/60">
          <p className="break-all">Token <a className="underline" href={tokenUrl(child.token)} target="_blank" rel="noreferrer">{child.token}</a> · hook <a className="underline" href={addressUrl(child.hook)} target="_blank" rel="noreferrer">{child.hook}</a></p>
          <p>Launched by {shortAddress(child.launcher)} · team {shortAddress(child.team)} · <a className="underline" href={txUrl(child.tx)} target="_blank" rel="noreferrer">launch tx ↗</a></p>
          <p>Trades pay and receive {q.symbol} through the Uniswap Universal Router{q.address !== zeroAddress ? `; paying with ${q.symbol} (not ETH) needs a Permit2 approval of ${q.symbol}` : ""}. The pair's issuer can pause or block its token: a paused {q.symbol} stops this pool's trades.</p>
        </div>
        {market && market.pendingAbsorbedTokens > 0n && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-l-[3px] border-violet bg-violet/10 px-3 py-3">
            <span className="font-mono text-[10px] uppercase tracking-wide">{fmtTokens(tokensToNumber(market.pendingAbsorbedTokens))} {child.symbol} from crossed walls wait in the hook. Anyone can deliver them to the governance vault.</span>
            <button disabled={tx.busy || store.wallet !== "connected" || store.wrongNetwork}
              onClick={() => void tx.run([{ label: "Deliver absorbed tokens", request: async () => deliverAbsorbedRequest(child.hook) }])}
              className="brutal bg-lime px-3 py-1.5 font-mono text-[10px] font-bold uppercase disabled:opacity-40">Deliver</button>
            {tx.error && <span role="alert" className="font-mono text-[10px] uppercase text-orange">{tx.error}</span>}
          </div>
        )}
      </div>
      <div><SwapWidget store={store} market={child} nextWall={nextWall} /></div>
    </div>
  );
}

/** A debounced estimate of the pair an ETH first buy yields, for the form, refreshed every 30 s so it never goes
 *  stale; the launch quotes again and refuses a result materially below it. */
function useEthRouteEstimate(quote: Address | null, amountIn: bigint) {
  const [estimate, setEstimate] = useState<{ key: string; value: { out: bigint; path: V3Path } | null } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setRound((r) => r + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const key = `${quote}:${amountIn}`;
  useEffect(() => {
    if (!quote || amountIn === 0n) return;
    let live = true;
    const timer = setTimeout(() => {
      bestEthRoute(readContext.client as never, CONFIG, quote, amountIn)
        .then((r) => { if (live) setEstimate({ key, value: r }); })
        .catch(() => { if (live) setEstimate({ key, value: null }); });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [quote, amountIn, key, round]);
  return estimate?.key === key ? estimate.value : undefined;
}
