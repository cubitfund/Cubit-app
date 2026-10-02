import { readContext, readAllChildren, blockClock, publicData } from "../chain/appChain";
import { useRelayAccess } from "../chain/useRelayAccess";
import { launchpadPage, launchpadReadTargets, mergeLaunchpadLaunches } from "../chain/launchpadPage";
import { readActionBlock } from "../chain/readContext";
import { readGovernanceDetails, TRANCHE_ROWS } from "../chain/tranches";
import { GovernanceDetail } from "../chain/governanceDetail";
// Launchpad — the public Forge, LIVE on Ethereum: anyone launches a token by paying the launch fee. Every
// token runs CUBIT's hook template in its own pool with the same parameters (21M supply, CUBIT's launch valuation, the
// whole supply in one band, taxes 3% buy / 15% sell = 12% walls + 3% the token's team). The launch fee is paid in ETH to
// the governance vault and never refunded: it belongs to CUBIT governance, never to the launcher and never to CUBIT's
// walls. The tokens a launched token's crossed walls absorb go to the governance vault too.
// A launch is prepared in the browser like script/ForgeLaunch.s.sol: the hook template is checked against the Forge's
// frozen hash, the child token's address predicted, then the hook salt mined so the hook address carries its flags.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { isAddress, zeroAddress, type Address } from "viem";
import { useStore } from "../Root";
import { CONFIG, addressUrl, sameAddress, shortAddress, tokenUrl, txUrl } from "../chain/config";
import {
  childHookAddress, childHookInitCodeHash, confirmsChildLaunch, deliverAbsorbedRequest, extendLockRequest, governanceClaimRequest,
  hasHookFlags, launchRequest, linkedHookCreationCode, mineHookSalt, NAME_MAX_BYTES, predictChildToken, randomSalt,
  readForge, SYMBOL_MAX_BYTES, utf8Length, type ChildLaunch, type ForgeView, type GovernanceView,
} from "../chain/launchpad";
import {
  clearPendingLaunch, matchesLaunch, readPendingLaunches, recordLaunchHash, savePendingLaunch,
  type LaunchIdentity, type PendingLaunch,
} from "../chain/pendingLaunch";
import { poolIdOf, type MarketState } from "../chain/market";
import { tokensToNumber, wadToNumber, weiToEth } from "../chain/math";
import { usePoll } from "../chain/usePoll";
import { errorMessage, useTx } from "../chain/tx";
import { fmtDate, fmtDuration, fmtEth, fmtEthAmount, fmtInt, fmtTokens, timeAgo } from "../format";
import { ComingSoon, Kpi, Panel, SlowTransaction, StatusTag } from "../components/primitives";
import { SwapWidget } from "../components/SwapWidget";
import { launchpadV2Configured } from "../chain/launchpadV2";

const isZero = (value?: string | null) => !value || /^0x0{40}$/i.test(value);

const HOW = [
  "Anyone launches: pick a name, a symbol and the team address that receives your token's team taxes, then pay the launch fee.",
  "Same parameters for every token: 21,000,000 fixed supply, CUBIT's launch valuation, the whole supply in one band placed at launch.",
  "Same taxes: 3% on buys to the token's team; 15% on sells, 12% into walls under the price and 3% to the token's team.",
  "The launch fee is paid in ETH to the CUBIT governance vault. It is not refunded: it belongs to governance, never to the launcher and never to CUBIT's walls.",
  "A launched token has no vault of its own: what its crossed walls absorb goes to the governance vault too.",
  "The team can register a launchpad v2 with other parameters; tokens already launched keep running on their own pools.",
];

export function Launchpad() {
  useRelayAccess();
  const store = useStore();
  const forgeAddress = store.modules && !isZero(store.modules.forge) ? store.modules.forge : null;
  // Once the registry names the launchpad v2, this page's first-launchpad form would send the wrong call: launches
  // then happen on /launchpad (the launchpad v2), and this page keeps listing and trading the tokens already launched.
  const v2Registered = launchpadV2Configured(CONFIG) && !!store.modules && sameAddress(store.modules.forge, CONFIG.forgeV2);
  const active = store.features.forge && !v2Registered;
  const forge = usePoll((block) => publicData.forge(forgeAddress!, block), [forgeAddress], 30_000, !!forgeAddress);
  const children = usePoll(readAllChildren, [forgeAddress], 15_000, true, true);
  const list = children.data ?? [];
  const [justLaunched, setJustLaunched] = useState<ChildLaunch | null>(null);
  const { launches: displayList, justLaunched: provisional } = mergeLaunchpadLaunches(list, justLaunched);
  useEffect(() => {
    if (!justLaunched) return;
    if (!provisional) { setJustLaunched(null); return; }
    // A launch the canonical reader never sees may have been reorged out.
    const timer = setTimeout(() => setJustLaunched((current) => current === justLaunched ? null : current), 120_000);
    return () => clearTimeout(timer);
  }, [justLaunched, provisional]);
  const [page, setPage] = useState(0);
  const { page: currentPage, pageCount, tokens: rows } = launchpadPage(displayList, page);
  const [selected, setSelected] = useState<Address | null>(null);
  const { tokens: recent, child, markets: visibleMarkets } = launchpadReadTargets(list, rows.map((c) => c.hook), selected);
  const markets = usePoll(async (block) => {
    const results = await Promise.allSettled(visibleMarkets.map((c) => publicData.market(c, block)));
    return results.map((result, i) => ({
      hook: visibleMarkets[i].hook,
      market: result.status === "fulfilled" ? result.value : null,
      error: result.status === "rejected" ? `${visibleMarkets[i].symbol}: ${errorMessage(result.reason)}` : null,
    }));
  }, [visibleMarkets.map((c) => c.hook).join()], 15_000, visibleMarkets.length > 0, true);
  const governanceVault = forge.data?.governanceVault ?? (forgeAddress || isZero(CONFIG.governanceVault) ? null : CONFIG.governanceVault);
  const account = store.wallet === "connected" && !store.wrongNetwork ? store.address : null;
  const governance = usePoll(
    (block) => publicData.governance(governanceVault!, recent, block, account, {}),
    [governanceVault, recent.map((c) => c.token).join(), account],
    15_000, !!governanceVault,
  );
  const childMarket = markets.data?.find((m) => sameAddress(m.hook, child?.hook))?.market ?? null;
  const ethAsset = governance.data?.assets.find((a) => a.token === zeroAddress);
  const refreshAll = () => {
    children.refresh();
    markets.refresh();
    governance.refresh();
    forge.refresh();
    store.refresh();
  };
  const onLaunched = (launched?: ChildLaunch) => {
    if (launched) { setJustLaunched(launched); setPage(0); }
    refreshAll();
  };

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b-[3px] border-ink pb-6">
        <div>
          <StatusTag tone={active ? "live" : "next"}>{active ? "Live · public · Ethereum" : forgeAddress ? "Registered · not active" : "Not registered"}</StatusTag>
          <h1 className="mt-3 font-display text-4xl uppercase leading-[0.9] md:text-7xl">The forge.</h1>
          <p className="mt-4 max-w-2xl font-mono text-[13px] leading-relaxed text-ink/75">
            A public launchpad: anyone launches a token by paying the launch fee. Every token runs CUBIT's market maker in
            its own pool — its own band, its own walls — with the same valuation, supply and taxes.
          </p>
        </div>
        <span className="brutal inline-block rotate-[6deg] bg-lime px-4 py-2 font-display text-xl uppercase">{active ? "Open to all" : "Closed"}</span>
      </div>
      {launchpadV2Configured(CONFIG) && (
        <p className="mb-8 border-l-[3px] border-violet bg-violet/10 px-3 py-2 font-mono text-[11px] uppercase tracking-wide">
          Launchpad v2: pair a token with ETH, a stablecoin, WBTC or a tokenized stock.{" "}
          <Link to="/launchpad" className="font-bold underline">Open the launchpad v2 →</Link>
        </p>
      )}

      {!active && (
        <ComingSoon className="mb-8"
          message={!forgeAddress && isZero(CONFIG.governanceVault) ? "The launchpad will be added after CUBIT launches. Launching tokens is not available yet." : undefined}
          secondary={forgeAddress ? "A Forge is registered, but launching is not activated yet." : "No Forge is registered in the registry yet."}>
          <button type="button" disabled className="brutal bg-ink/15 px-4 py-3 font-mono text-[12px] font-bold uppercase tracking-widest text-ink/50 disabled:cursor-not-allowed">Launch token</button>
        </ComingSoon>
      )}

      <div className="grid grid-cols-2 border-[3px] border-ink lg:grid-cols-4">
        <div className="border-b-[3px] border-r-[3px] border-ink lg:border-b-0"><Kpi label="Launch fee" value={forge.data ? `${fmtEthAmount(weiToEth(forge.data.launchFee))} ETH` : "—"} unit="paid to governance · not refunded" /></div>
        <div className="border-b-[3px] border-ink lg:border-b-0 lg:border-r-[3px]"><Kpi label="Tokens launched" value={children.data ? fmtInt(displayList.length) : "—"} unit="by anyone" accent="#5b4bff" /></div>
        <div className="border-r-[3px] border-ink"><Kpi label="Fees held for governance" value={ethAsset ? `${fmtEthAmount(weiToEth(ethAsset.held))} ETH` : "—"} unit="in the governance vault" accent="#7a9e00" /></div>
        <div><Kpi label="Governance vault" value={governanceVault ? shortAddress(governanceVault) : "—"} unit="receives every launch fee" /></div>
      </div>
      {(forge.error || children.error) && <p role="alert" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-orange">Launchpad data unavailable: {forge.error ?? children.error}</p>}

      <div className={`mt-10 grid gap-8 [&>*]:min-w-0 ${active ? "lg:grid-cols-3" : ""}`}>
        <div className={active ? "lg:col-span-2" : ""}>
          <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">How the launchpad works</h2>
          <div className="border-[3px] border-ink">
            {HOW.map((h, i) => (
              <div key={h} className={`flex gap-3 px-4 py-4 font-mono text-[12px] leading-relaxed text-ink/80 ${i > 0 ? "border-t border-dashed border-ink/25" : ""}`}>
                <span className="font-bold text-violet">{String(i + 1).padStart(2, "0")}</span>
                <span>{h}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 font-mono text-[10px] uppercase leading-relaxed tracking-wide text-ink/45">
            A launched token's walls are finite support, not a guarantee.
          </p>
        </div>
        {active && <LaunchForm key={forgeAddress} store={store} forge={forge.data} forgeAddress={forgeAddress} active={active} onLaunched={onLaunched} onSelect={setSelected} />}
      </div>

      {/* launched tokens */}
      <div className="mt-10">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">Launched tokens</h2>
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left font-mono text-[11px] tabular-nums">
              <thead>
                <tr className="border-b-[2px] border-ink text-[9px] uppercase tracking-widest text-ink/50">
                  <th className="px-4 py-2 font-normal">Token</th>
                  <th className="px-4 py-2 text-right font-normal">Price (ETH)</th>
                  <th className="px-4 py-2 text-right font-normal">vs launch</th>
                  <th className="px-4 py-2 text-right font-normal">ETH in walls</th>
                  <th className="px-4 py-2 text-right font-normal">Walls</th>
                  <th className="px-4 py-2 font-normal">Launcher · team</th>
                  <th className="px-4 py-2 text-right font-normal" />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-ink/45">{children.loading ? "Reading the launches…" : "No token launched yet: be the first."}</td></tr>
                )}
                {rows.map((c) => (
                  <ChildRow key={c.hook} child={c} current={forgeAddress} market={sameAddress(c.hook, provisional?.hook) ? null : markets.data?.find((m) => sameAddress(m.hook, c.hook))?.market ?? null} justLaunched={sameAddress(c.hook, provisional?.hook)} selected={sameAddress(child?.hook, c.hook)} onTrade={() => setSelected(c.hook)} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        {markets.error && <p role="alert" className="mt-2 font-mono text-[10px] text-orange">{markets.error}</p>}
        {markets.data?.filter((m) => m.error).map((m) => <p role="alert" key={m.hook} className="mt-2 font-mono text-[10px] text-orange">Market unavailable: {m.error}</p>)}
        {pageCount > 1 && <div className="mt-3 flex gap-3 font-mono text-[11px]">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="underline disabled:opacity-40">Previous</button>
          <span>Page {currentPage + 1} / {pageCount} · {displayList.length} launches</span>
          <button disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)} className="underline disabled:opacity-40">Next</button>
        </div>}
      </div>

      {child && <ChildPanel key={child.hook} store={store} child={child} market={childMarket} onDone={refreshAll} />}

      <GovernancePanel key={`${governanceVault}:${account}`} store={store} view={governance.data} error={governance.error} onDone={refreshAll} />
    </div>
  );
}

function LaunchForm({ store, forge, forgeAddress, active, onLaunched, onSelect }: {
  store: ReturnType<typeof useStore>;
  forge: ForgeView | null;
  forgeAddress: Address | null;
  active: boolean;
  onLaunched: (child?: ChildLaunch) => void;
  onSelect: (hook: Address) => void;
}) {
  const account = store.wallet === "connected" ? store.address : null;
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [team, setTeam] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ token: Address; hook: Address; symbol: string } | null>(null);
  // Launches prepared but never seen confirmed, this wallet's only, including from an earlier visit.
  const [pending, setPending] = useState<PendingLaunch[]>([]);
  const sent = useRef<LaunchIdentity | null>(null);
  const prepared = useRef<Omit<ChildLaunch, "fromBlock" | "tx"> | null>(null);
  const tx = useTx((receipt) => {
    if (receipt && prepared.current && confirmsChildLaunch(receipt, prepared.current)) {
      const child: ChildLaunch = { ...prepared.current, fromBlock: receipt.blockNumber, tx: receipt.transactionHash };
      onLaunched(child);
      onSelect(child.hook);
    } else {
      setLaunched(null);
      onLaunched();
    }
  });
  useEffect(() => { setPending(readPendingLaunches(CONFIG.chainId, account)); }, [account]);
  useEffect(() => {
    if (!tx.hash || !sent.current) return;
    recordLaunchHash(sent.current, tx.hash);
    setPending(readPendingLaunches(CONFIG.chainId, sent.current.launcher));
  }, [tx.hash]);
  const cleanName = name.trim();
  const cleanSymbol = symbol.trim();
  const teamAddress = team.trim() || account || "";
  const nameBytes = utf8Length(cleanName);
  const symbolBytes = utf8Length(cleanSymbol);
  const teamValid = isAddress(teamAddress) && !isZero(teamAddress) && !sameAddress(teamAddress, CONFIG.hook);
  const valid = nameBytes > 0 && nameBytes <= NAME_MAX_BYTES && symbolBytes > 0 && symbolBytes <= SYMBOL_MAX_BYTES && teamValid;

  /** `replay` re-sends a launch already in flight, whatever the form now shows: starting over must never send a
   *  different token, which would pay a second launch fee for real. */
  const launch = async (replay?: LaunchIdentity) => {
    if (!account || !forgeAddress) return;
    if (replay && !sameAddress(replay.launcher, account)) return;
    const identity: LaunchIdentity = replay
      ?? { chainId: CONFIG.chainId, launcher: account, name: cleanName, symbol: cleanSymbol, team: teamAddress as Address };
    const { launcher, name: launchName, symbol: launchSymbol, team: launchTeam } = identity;
    // The same token keeps the salts of its first attempt: a second send then collides with the CREATE2 address
    // already taken and reverts, instead of launching a twin and paying the fee — never refunded — twice.
    const saved = matchesLaunch(readPendingLaunches(CONFIG.chainId, launcher), identity);
    sent.current = identity;
    prepared.current = null;
    const tokenSalt = saved?.tokenSalt ?? randomSalt();
    setLaunched(null);
    setProgress(null);
    const ok = await tx.run([{
      label: "Preparing the launch",
      request: async (check) => {
        const block = await readActionBlock(readContext, () => blockClock.refresh(), check);
        check();
        const f = await readForge(readContext, forgeAddress, block);
        check();
        if (!f.templateMatches) throw new Error("The Forge's hook template differs from this app's build. Reload the app.");
        const creationCode = linkedHookCreationCode(readContext.config);
        const token = predictChildToken(f.forge, launcher, tokenSalt, launchName, launchSymbol);
        const initCodeHash = childHookInitCodeHash(creationCode, f.poolManager, token, launchTeam, f.launchEth);
        // A slow first attempt may have been included while the app showed an error or was closed.
        if (saved) {
          const code = await readContext.client.getCode({ address: token });
          check();
          if (code && code !== "0x") {
            clearPendingLaunch(identity);
            setPending(readPendingLaunches(CONFIG.chainId, launcher));
            if (saved.hook) onSelect(saved.hook);
            throw new Error("That launch already went through: this token exists and its fee is paid. Nothing to send.");
          }
        }
        // The saved salt only holds while the Forge's template, pool manager and launch valuation are unchanged.
        const kept = saved?.hookSalt ? childHookAddress(f.forge, launcher, saved.hookSalt, initCodeHash) : null;
        const mined = kept && hasHookFlags(kept)
          ? { salt: saved!.hookSalt!, hook: kept, tries: 0 }
          : await mineHookSalt(readContext, f.forge, launcher, initCodeHash, (tries) => { check(); setProgress(`Mining the hook address · ${fmtInt(tries)} salts tried`); }, () => { try { check(); return false; } catch { return true; } });
        check();
        setProgress(mined.tries === 0 ? "Reusing the address prepared for this launch" : `Hook address found after ${fmtInt(mined.tries)} salts`);
        const record: PendingLaunch = {
          ...identity, tokenSalt, hookSalt: mined.salt, token, hook: mined.hook, hash: saved?.hash ?? null, at: Date.now(),
        };
        savePendingLaunch(record);
        setPending(readPendingLaunches(CONFIG.chainId, launcher));
        prepared.current = {
          token, hook: mined.hook, name: launchName, symbol: launchSymbol, launcher, team: launchTeam,
          fee: f.launchFee, forge: f.forge, poolId: poolIdOf(token, mined.hook), parent: false,
        };
        setLaunched({ token, hook: mined.hook, symbol: launchSymbol });
        return launchRequest(f.forge, f.launchFee, launchName, launchSymbol, launchTeam, tokenSalt, mined.salt, creationCode);
      },
    }]);
    if (ok) {
      clearPendingLaunch(identity);
      setPending(readPendingLaunches(CONFIG.chainId, launcher));
      setName("");
      setSymbol("");
    } else {
      setLaunched(null);
    }
  };

  let label = "Launch token";
  let action: () => void = () => void launch();
  let disabled = false;
  if (store.wallet === "connecting") [label, disabled] = ["Connecting…", true];
  else if (store.wallet !== "connected") [label, action] = ["Connect wallet to launch", () => store.connect()];
  else if (store.wrongNetwork) [label, action] = [`Switch to ${CONFIG.chainName}`, store.switchNetwork];
  else if (!active) [label, disabled] = ["Launchpad not active", true];
  else if (tx.phase === "working") [label, disabled] = [progress ?? "Preparing…", true];
  else if (tx.phase === "signing") [label, disabled] = ["Confirm in your wallet…", true];
  else if (tx.phase === "pending") [label, disabled] = [tx.slow ? "Still pending…" : "Launch pending…", true];
  else if (tx.phase === "success") [label, disabled] = [launched ? "Launched ✓" : "Transaction confirmed", true];
  else if (!valid) [label, disabled] = ["Fill in the token", true];
  else if (forge && !forge.templateMatches) [label, disabled] = ["Template mismatch", true];

  return (
    <Panel className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest">Launch a token</h2>
        <StatusTag tone={active ? "live" : "muted"}>{active ? "Open" : "Closed"}</StatusTag>
      </div>
      {(tx.phase === "idle" || tx.phase === "error") && pending.filter((p) => p.hash).map((p) => (
        <div key={p.tokenSalt} role="alert" className="mb-4 space-y-1 border-l-[3px] border-orange bg-orange/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wide">
          <p className="font-bold">A launch of {p.symbol} was already sent · {timeAgo(p.at)}</p>
          <p className="normal-case text-ink/75">
            It may still be waiting for inclusion. Check it before paying the launch fee again: the fee is never
            refunded. Restoring its fields reuses the same addresses, so a second send reverts instead of launching a
            second token.
          </p>
          <a className="block break-all underline" href={txUrl(p.hash!)} target="_blank" rel="noreferrer">View transaction ↗</a>
          <div className="flex gap-4 pt-1">
            <button type="button" className="underline" onClick={() => { setName(p.name); setSymbol(p.symbol); setTeam(p.team); }}>Restore its fields</button>
            <button type="button" className="underline" onClick={() => { clearPendingLaunch(p); setPending(readPendingLaunches(CONFIG.chainId, p.launcher)); }}>Forget it</button>
          </div>
        </div>
      ))}
      <FormField label="Name" hint={`${nameBytes}/${NAME_MAX_BYTES} bytes`} value={name} onChange={setName} placeholder="My token" invalid={nameBytes > NAME_MAX_BYTES} />
      <FormField label="Symbol" hint={`${symbolBytes}/${SYMBOL_MAX_BYTES} bytes`} value={symbol} onChange={setSymbol} placeholder="MTK" invalid={symbolBytes > SYMBOL_MAX_BYTES} />
      <FormField label="Team address (receives the token's team taxes)" hint={team ? (teamValid ? "valid" : "invalid") : "default: your wallet"} value={team} onChange={setTeam} placeholder={account ?? "0x…"} invalid={!!team && !teamValid} />

      <div className="mb-4 space-y-1.5 border-l-[3px] border-ink/20 pl-3 font-mono text-[10px] uppercase tracking-wide text-ink/70">
        <Row l="Launch fee" r={forge ? `${fmtEthAmount(weiToEth(forge.launchFee))} ETH + gas` : "—"} />
        <Row l="The fee goes to" r="CUBIT governance · not refunded" />
        <Row l="Supply" r="21,000,000 · all in the band" />
        <Row l="Launch valuation" r={forge ? `${fmtEthAmount(weiToEth(forge.launchEth))} ETH FDV` : "—"} />
        <Row l="Taxes" r="3% buy · 15% sell (12% walls)" />
        <Row l="Hook template" r={forge ? (forge.templateMatches ? "matches the Forge ✓" : "mismatch") : "—"} accent={forge?.templateMatches ? "#7a9e00" : undefined} />
      </div>

      <button
        onClick={action}
        disabled={disabled}
        className={`brutal brutal-lift w-full py-3 font-mono text-[12px] font-bold uppercase tracking-widest disabled:cursor-not-allowed ${tx.phase === "success" ? "bg-lime text-ink" : disabled ? "bg-ink/15 text-ink/55" : "bg-violet text-cream"}`}
      >
        {label}
      </button>

      {progress && tx.phase !== "idle" && tx.phase !== "error" && <p role="status" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-ink/70">{progress}</p>}
      <SlowTransaction
        tx={tx}
        onRestart={() => {
          const again = sent.current;
          if (!again) return;
          // The form follows what is actually being re-sent.
          setName(again.name);
          setSymbol(again.symbol);
          setTeam(again.team);
          void launch(again);
        }}
        restartNote="Starting over sends this same launch again, with the same addresses: if the first one lands, the second reverts and the launch fee is never paid twice."
        className="mt-3"
      />
      {launched && (
        <div className="mt-3 space-y-1 border-l-[3px] border-lime bg-lime/15 px-3 py-2 font-mono text-[10px] uppercase tracking-wide">
          <p>{tx.phase === "success" ? "Launched" : "Launching"} {launched.symbol}</p>
          <p className="break-all normal-case">token <a className="underline" href={tokenUrl(launched.token)} target="_blank" rel="noreferrer">{launched.token}</a></p>
          <p className="break-all normal-case">hook <a className="underline" href={addressUrl(launched.hook)} target="_blank" rel="noreferrer">{launched.hook}</a></p>
        </div>
      )}
      {tx.error && <p role="alert" className="mt-3 break-words font-mono text-[10px] uppercase tracking-wide text-orange">{tx.error}</p>}
      {tx.hash && <a href={txUrl(tx.hash)} target="_blank" rel="noreferrer" className="mt-2 block font-mono text-[10px] uppercase tracking-widest text-violet underline">View transaction ↗</a>}
      <p className="mt-4 font-mono text-[9px] uppercase leading-relaxed tracking-widest text-ink/40">
        The app predicts your token's address and mines the hook salt the Forge binds to your wallet (a few thousand hashes),
        then one transaction pays the fee to governance and deploys the token, its hook and its pool.
      </p>
    </Panel>
  );
}

function ChildRow({ child, current, market, justLaunched, selected, onTrade }: { child: ChildLaunch; current: Address | null; market: MarketState | null; justLaunched: boolean; selected: boolean; onTrade: () => void }) {
  const price = market && !market.priceUnavailable ? wadToNumber(market.priceWad) : null;
  const launch = market ? wadToNumber(market.launchPriceWad) : null;
  return (
    <tr className={`border-b border-dashed border-ink/25 last:border-b-0 ${selected ? "bg-lime/15" : ""}`}>
      <td className="px-4 py-3">
        <a href={tokenUrl(child.token)} target="_blank" rel="noreferrer" className="font-bold underline hover:text-violet">{child.symbol}</a>
        <span className="ml-2 text-ink/55">{child.name}</span>
        {current && !sameAddress(child.forge, current) && <span className="ml-2 border border-ink/40 px-1 text-[9px] uppercase text-ink/55">earlier launchpad</span>}
        {justLaunched && <span title="Provisional: not yet read from launchpad data." className="ml-2 border border-orange/40 px-1 text-[9px] uppercase text-orange">just launched</span>}
      </td>
      <td className="px-4 py-3 text-right">{price === null ? "—" : fmtEth(price)}</td>
      <td className="px-4 py-3 text-right">{price !== null && launch ? `${(price / launch).toFixed(2)}×` : "—"}</td>
      <td className="px-4 py-3 text-right">{market ? fmtEthAmount(weiToEth(market.wallEth)) : "—"}</td>
      <td className="px-4 py-3 text-right">{market ? `${market.activeWalls + market.partialWalls} · ${market.crossedWalls} crossed` : "—"}</td>
      <td className="px-4 py-3 text-ink/60">{shortAddress(child.launcher)} · {shortAddress(child.team)}</td>
      <td className="px-4 py-3 text-right">
        <span className="inline-flex gap-2">
          <button disabled={justLaunched} onClick={onTrade} className="brutal bg-violet px-2 py-1 text-[10px] font-bold uppercase text-cream disabled:opacity-40">Trade</button>
          {justLaunched
            ? <span aria-disabled="true" className="brutal bg-cream px-2 py-1 text-[10px] font-bold uppercase opacity-40">Momentum</span>
            : <Link to={`/momentum?token=${child.token}`} className="brutal bg-cream px-2 py-1 text-[10px] font-bold uppercase">Momentum</Link>}
        </span>
        {justLaunched && <span className="mt-1 block text-[9px] text-ink/55">Waiting for launchpad data.</span>}
      </td>
    </tr>
  );
}

function ChildPanel({ store, child, market, onDone }: { store: ReturnType<typeof useStore>; child: ChildLaunch; market: MarketState | null; onDone: () => void }) {
  const tx = useTx(onDone);
  const nextWall = market?.nextWall ? { level: wadToNumber(market.nextWall.priceWad), underMarket: market.nextWall.underMarket } : null;
  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-3 [&>*]:min-w-0">
      <div className="lg:col-span-2">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">{child.symbol} — {child.name}</h2>
        <div className="grid grid-cols-2 border-[3px] border-ink md:grid-cols-3">
          <Cell label="Market price" value={market && !market.priceUnavailable ? fmtEth(wadToNumber(market.priceWad)) : "—"} unit="ETH" />
          <Cell label="FDV" value={market && !market.priceUnavailable ? fmtEthAmount(wadToNumber(market.priceWad) * tokensToNumber(market.totalSupply)) : "—"} unit="ETH" />
          <Cell label="ETH in walls" value={market ? fmtEthAmount(weiToEth(market.wallEth)) : "—"} unit={market ? `${market.activeWalls + market.partialWalls} standing` : ""} />
          <Cell label="Band" value={market ? fmtTokens(tokensToNumber(market.band.cubit)) : "—"} unit={market ? `${child.symbol} · ${fmtEthAmount(weiToEth(market.band.eth))} ETH` : ""} />
          <Cell label="Pending wall funds" value={market ? fmtEthAmount(weiToEth(market.pendingFloorEth)) : "—"} unit="ETH" />
          <Cell label="Absorbed, awaiting delivery" value={market ? fmtTokens(tokensToNumber(market.pendingAbsorbedTokens)) : "—"} unit={`${child.symbol} → governance vault`} />
        </div>
        <div className="mt-4 space-y-1.5 font-mono text-[10px] uppercase tracking-wide text-ink/60">
          <p className="break-all">Token <a className="underline" href={tokenUrl(child.token)} target="_blank" rel="noreferrer">{child.token}</a> · hook <a className="underline" href={addressUrl(child.hook)} target="_blank" rel="noreferrer">{child.hook}</a></p>
          <p>Launched by {shortAddress(child.launcher)} at block {fmtInt(Number(child.fromBlock))} · team {shortAddress(child.team)} · <a className="underline" href={txUrl(child.tx)} target="_blank" rel="noreferrer">launch tx ↗</a></p>
          <p>Trades go through the canonical Uniswap Universal Router; sales need a Permit2 approval. The CUBIT router serves the CUBIT pool only.</p>
        </div>
        {market && market.pendingAbsorbedTokens > 0n && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-l-[3px] border-violet bg-violet/10 px-3 py-3">
            <span className="font-mono text-[10px] uppercase tracking-wide">
              {fmtTokens(tokensToNumber(market.pendingAbsorbedTokens))} {child.symbol} from crossed walls wait in the hook. Anyone can deliver them to the governance vault.
            </span>
            <button
              disabled={tx.busy || store.wallet !== "connected" || store.wrongNetwork}
              onClick={() => void tx.run([{ label: "Deliver absorbed tokens", request: async () => deliverAbsorbedRequest(child.hook) }])}
              className="brutal bg-lime px-3 py-1.5 font-mono text-[10px] font-bold uppercase disabled:opacity-40"
            >
              Deliver
            </button>
            {tx.error && <span role="alert" className="font-mono text-[10px] uppercase text-orange">{tx.error}</span>}
          </div>
        )}
      </div>
      <div>
        <SwapWidget store={store} market={child} nextWall={nextWall} />
      </div>
    </div>
  );
}

function GovernancePanel({ store, view, error, onDone }: { store: ReturnType<typeof useStore>; view: GovernanceView | null; error: string | null; onDone: () => void }) {
  const [detailReads] = useState(() => new GovernanceDetail((snapshot, token, held, page, signal) =>
    readGovernanceDetails(readContext, snapshot.vault, token, held, snapshot.block, page, signal)));
  const detailStates = useSyncExternalStore(detailReads.subscribe, detailReads.snapshot);
  useEffect(() => () => detailReads.invalidate(), [detailReads]);
  const tx = useTx(() => { detailReads.invalidate(); onDone(); });
  const [days, setDays] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  // Public totals stay cheap; only the governance key requests the bounded detail.
  const isDeployer = !!view && sameAddress(store.address, view.deployer) && !store.wrongNetwork;
  const extraDays = /^\d+$/.test(days) ? Number(days) : 0;
  const vault = view?.vault ?? (isZero(CONFIG.governanceVault) ? null : CONFIG.governanceVault);
  return (
    <div className="mt-10">
      <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">Governance vault</h2>
      <Panel className="p-5">
        <p className="max-w-3xl font-mono text-[11px] leading-relaxed text-ink/70">
          CUBIT governance's treasury: every launch fee, in ETH, and the tokens launched tokens' crossed walls absorb. What
          arrives here belongs to governance: launchers are not refunded, and only the governance key can move funds out.
          {" "}Everyone sees the total held. The governance key can load each asset's claimable amounts and unlock dates on demand. Details stay dated until refreshed and are cleared after a claim or lock extension attempt.
        </p>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[10px] uppercase tracking-wide text-ink/60">
          <span className="break-all">Vault {vault
            ? <a className="normal-case underline" href={addressUrl(vault)} target="_blank" rel="noreferrer">{vault} ↗</a>
            : "Not deployed"}</span>
          <span>Governance key {view ? shortAddress(view.deployer) : "—"}</span>
        </div>
        {error && <p role="alert" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-orange">{error}</p>}

        <div className="mt-4 overflow-x-auto">
          <table className={`w-full text-left font-mono text-[11px] tabular-nums ${isDeployer ? "min-w-[720px]" : "min-w-[360px]"}`}>
            <thead>
              <tr className="border-b-[2px] border-ink text-[9px] uppercase tracking-widest text-ink/50">
                <th className="px-3 py-2 font-normal">Asset</th>
                <th className="px-3 py-2 text-right font-normal">Held for governance</th>
                {isDeployer && (
                  <>
                    <th className="px-3 py-2 text-right font-normal">Claimable / locked</th>
                    <th className="px-3 py-2 font-normal">Next claim</th>
                    <th className="px-3 py-2 text-right font-normal" />
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {(view?.assets ?? []).map((a) => {
                const amount = (v: bigint) => (a.token === zeroAddress ? `${fmtEthAmount(weiToEth(v))} ETH` : `${fmtTokens(tokensToNumber(v))} ${a.symbol}`);
                const state = detailStates.get(a.token.toLowerCase());
                const d = state?.details;
                const next = d?.nextLocked;
                const fresh = state?.block.hash === view?.block.hash;
                return (
                  <tr key={a.token} className="border-b border-dashed border-ink/25 align-top last:border-b-0">
                    <td className="px-3 py-2 font-bold">{a.token === zeroAddress ? "ETH (launch fees)" : <a className="underline" href={tokenUrl(a.token)} target="_blank" rel="noreferrer">{a.symbol}</a>}</td>
                    <td className="px-3 py-2 text-right">{amount(a.held)}</td>
                    {isDeployer && (
                      <>
                        <td className="px-3 py-2 text-right">
                          {d ? <><span style={{ color: d.claimable > 0n ? "#7a9e00" : undefined }}>{amount(d.claimable)} claimable</span><br /><span className="text-ink/60">{amount(d.locked)} locked</span></> : "—"}
                          {state && <p className="mt-1 text-[10px] text-ink/60">Detail at {fmtDate(Number(state.block.timestamp))}<br />Held then: {amount(state.held)}{!fresh && <><br />Earlier snapshot · refresh to update</>}</p>}
                        </td>
                        <td className="px-3 py-2">
                          {!d ? <span role="status" className={state?.error ? "text-orange" : "text-ink/60"}>{state?.loading ? "Loading detail… Total held is shown." : state?.error ?? "Load detail to see claimable amounts."}</span>
                            : next ? fmtDate(Number(next.unlockAt)) : state!.held > 0n && d.locked === 0n ? "everything claimable at this snapshot" : "—"}
                          <p className="mt-1">
                            <button disabled={tx.busy || state?.loading} onClick={() => view && void detailReads.request(view, a.token)} className="underline disabled:opacity-40">{state ? "Refresh detail" : "Load detail"}</button>
                            {d && d.tranches.length === 0 && d.nextTranche < d.trancheCount && <button disabled={tx.busy || state?.loading} onClick={() => view && void detailReads.request(view, a.token, 0)} className="ml-3 underline disabled:opacity-40">Show tranches</button>}
                          </p>
                          {d && d.tranches.length > 0 && (
                            <details open className="mt-1 text-[10px] text-ink/60">
                              <summary className="cursor-pointer uppercase tracking-widest">{d.tranches.length} tranche{d.tranches.length > 1 ? "s" : ""}</summary>
                              <p className="my-2 flex gap-2">
                                <button className="underline disabled:opacity-40" disabled={tx.busy || d.page === 0} onClick={() => view && void detailReads.request(view, a.token, d.page - 1)}>Previous</button>
                                <span>Page {d.page + 1}</span>
                                <button className="underline disabled:opacity-40" disabled={tx.busy || d.nextTranche + BigInt(d.page + 1) * TRANCHE_ROWS >= d.trancheCount} onClick={() => view && void detailReads.request(view, a.token, d.page + 1)}>Next</button>
                              </p>
                              {d.tranches.map((t) => <p key={String(t.index)}>#{String(t.index)} · {amount(t.amount)} · {fmtDate(Number(t.unlockAt))}</p>)}
                            </details>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {a.held > 0n && (!d || !fresh || d.claimable > 0n) && (
                            <>
                              <button disabled={tx.busy} onClick={() => view && void tx.run([{ label: `Claim ${a.symbol}`, request: async () => governanceClaimRequest(view.vault, a.token) }])} className="brutal bg-lime px-2 py-1 text-[10px] font-bold uppercase disabled:opacity-40">{d && fresh ? "Claim" : "Try claim"} · up to 64 tranches</button>
                              {(!d || !fresh) && <p className="mt-1 text-[10px] text-ink/60">May revert if nothing is unlocked.</p>}
                            </>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
              {!view && <tr><td colSpan={isDeployer ? 5 : 2} className="px-3 py-6 text-ink/45">Reading the governance vault…</td></tr>}
            </tbody>
          </table>
        </div>

        {isDeployer && view && (
          <div className="mt-6 border-t-2 border-dashed border-ink/25 pt-4">
            <h3 className="font-mono text-[11px] font-bold uppercase tracking-widest">Governance key · extend the lock</h3>
            <p className="mt-2 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wide text-orange">
              Adds time to every lock, present and future, of every asset. It can never be shortened or undone.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="days" aria-label="Days to add" className="w-28 border-[2px] border-ink bg-cream px-2 py-2 font-mono text-sm font-bold" />
              <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                I understand it is permanent
              </label>
              <button
                disabled={tx.busy || extraDays <= 0 || !confirmed}
                onClick={() => void tx.run([{ label: "Extend the lock", request: async () => extendLockRequest(view.vault, BigInt(extraDays) * 86_400n) }]).then((ok) => ok && (setDays(""), setConfirmed(false)))}
                className="brutal bg-orange px-3 py-2 font-mono text-[10px] font-bold uppercase text-cream disabled:opacity-40"
              >
                Extend by {extraDays || 0} day{extraDays === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}
        {tx.phase !== "idle" && tx.phase !== "error" && <p role="status" className="mt-3 font-mono text-[10px] uppercase tracking-wide">{tx.label}: {tx.phase === "signing" ? "confirm in your wallet…" : tx.phase === "pending" ? (tx.slow ? "still pending" : "pending…") : tx.phase === "success" ? "confirmed ✓" : "…"}</p>}
        <SlowTransaction tx={tx} className="mt-3" />
        {tx.error && <p role="alert" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-orange">{tx.error}</p>}
        {tx.hash && <a href={txUrl(tx.hash)} target="_blank" rel="noreferrer" className="mt-2 block font-mono text-[10px] uppercase tracking-widest text-violet underline">View transaction ↗</a>}
        {view && <p className="mt-3 font-mono text-[9px] uppercase tracking-widest text-ink/40">Chain time {fmtDate(Number(view.block.timestamp))} · updated {timeAgo(Number(view.block.timestamp) * 1000)}</p>}
      </Panel>
    </div>
  );
}

export function FormField({ label, hint, value, onChange, placeholder, invalid }: { label: string; hint: string; value: string; onChange: (v: string) => void; placeholder: string; invalid?: boolean }) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="font-mono text-[10px] uppercase tracking-widest text-ink/55">{label}</label>
        <span className={`font-mono text-[9px] uppercase tracking-widest ${invalid ? "text-orange" : "text-ink/40"}`}>{hint}</span>
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={`w-full border-[2px] bg-cream px-3 py-2 font-mono text-sm font-bold outline-none focus:border-violet ${invalid ? "border-orange" : "border-ink"}`}
      />
    </div>
  );
}

export function Row({ l, r, accent }: { l: string; r: string; accent?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{l}</span>
      <span className="text-right font-bold tabular-nums" style={{ color: accent }}>{r}</span>
    </div>
  );
}

export function Cell({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="border-b-[3px] border-r-[3px] border-ink px-4 py-4 [&:nth-child(2n)]:border-r-0 md:[&:nth-child(2n)]:border-r-[3px] md:[&:nth-child(3n)]:border-r-0 md:[&:nth-child(n+4)]:border-b-0">
      <p className="font-mono text-[9px] uppercase tracking-widest text-ink/45">{label}</p>
      <p className="mt-1.5 font-mono text-[13px] font-bold tabular-nums [overflow-wrap:anywhere] sm:text-base">{value}</p>
      <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink/40">{unit}</p>
    </div>
  );
}
