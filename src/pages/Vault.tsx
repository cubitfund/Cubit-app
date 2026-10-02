import { publicData } from "../chain/appChain";
import { useRelayAccess } from "../chain/useRelayAccess";
// Vault — stake CUBIT, earn CUBIT from a FINITE reserve, LIVE on Ethereum. Deposits need the team's Vault
// activation (feature bit 1); withdrawals and claims never do. Rewards: 3% of the stake per 24h, capped at one period,
// paid from the vault's reserve (seeded at launch with 20% of the supply, refilled by crossed walls). No WETH, no mint.
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { maxUint256, type Address, type TransactionReceipt } from "viem";
import { useStore } from "../Root";
import { CONFIG, addressUrl, sameAddress, txUrl } from "../chain/config";
import { formatUnits18, parseAmount, tokensToNumber } from "../chain/math";
import { usePoll } from "../chain/usePoll";
import { useTx } from "../chain/tx";
import { approveRequest } from "../chain/swap";
import { claimRequest, compoundPlan, newestVaultView, stakeRequest, withdrawRequest, type VaultView } from "../chain/vault";
import { fmtDate, fmtDuration, fmtTokens } from "../format";
import { ComingSoon, Panel, SlowTransaction, StatusTag } from "../components/primitives";
import { VAULT_PUBLIC } from "../launch";

const HOW = [
  "Rewards are paid in CUBIT from a finite reserve — when it's empty, rewards stop, nothing mints more.",
  "Claimable amount caps at one day of accrual: claim daily or lose the excess.",
  "Every new deposit restarts a 24h lock on your whole position.",
  "Staking, withdrawing and claiming pay what accrued so far and restart the 24h window.",
  "Compound restakes what you can claim in one transaction; like any deposit, it restarts the 24h lock.",
  "Staked CUBIT still counts as circulating supply — a vault is not a burn.",
  "The vault has zero rights over wall ETH. Absorbed CUBIT from crossed walls flows into its reserve.",
];

export function Vault() {
  useRelayAccess();
  const store = useStore();
  const account = store.wallet === "connected" ? store.address : null;
  const current = store.modules?.vault ?? CONFIG.vault;
  const onChain = store.features.vault;
  // Open on chain but "coming soon" in the app until its public launch (launch.ts); `?preview` shows the full page.
  const preview = new URLSearchParams(useLocation().search).has("preview");
  const active = onChain && (VAULT_PUBLIC || preview);
  const teaser = onChain && !active;
  // Before the launch, only a connected account is read, to find a position it already holds.
  const view = usePoll((block) => publicData.vault(current, true, account, block), [current, account], 8_000, active || (teaser && !!account));
  const all = usePoll((block) => publicData.vaultAddresses(block), [store.modules?.revision?.toString()], 60_000, active);
  const retired = (all.data ?? []).filter((v) => !sameAddress(v, current));
  // Right after the account's own transaction, its position is read at that transaction's block through the direct
  // RPC; the page shows whichever reading is newer, so it neither waits for the shared snapshot nor goes back to it.
  const key = `${current}:${account ?? ""}`.toLowerCase();
  const [fresh, setFresh] = useState<{ key: string; view: VaultView } | null>(null);
  const v = newestVaultView(view.data, fresh?.key === key ? fresh.view : null);
  const afterTx = (receipt?: TransactionReceipt) => {
    view.refresh(); store.refresh();
    if (!receipt || !account) return;
    void publicData.vaultAt(current, true, account, receipt).then((next) => setFresh({ key, view: next }), () => {});
  };
  const holder = !!v?.position && (v.position.staked > 0n || v.position.pending > 0n);
  const panel = active || (teaser && holder);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b-[3px] border-ink pb-6">
        <div>
          <StatusTag tone={active ? "live" : "next"}>{active ? "Live · Ethereum" : teaser ? "Coming soon" : "Not active · deposits closed"}</StatusTag>
          <h1 className="mt-3 font-display text-4xl uppercase leading-[0.9] md:text-7xl">The vault.</h1>
          <p className="mt-4 max-w-2xl font-mono text-[13px] leading-relaxed text-ink/75">
            Stake CUBIT, earn CUBIT. 3% of your stake per day from a finite reserve — funded at launch with 20% of the supply
            (4.2M CUBIT) and refilled by every wall that gets crossed.
          </p>
        </div>
        <a href={addressUrl(current)} target="_blank" rel="noreferrer" className="brutal inline-block rotate-[6deg] bg-lime px-4 py-2 font-display text-xl uppercase">
          {active ? "Open" : teaser ? "Soon" : "Closed"}
        </a>
      </div>

      {teaser && (
        <ComingSoon className="mb-8" message="The Vault opens to everyone soon."
          secondary={holder ? "You already have a position: claim, compound or withdraw it below." : undefined} />
      )}

      {!onChain && (
        <ComingSoon className="mb-8" secondary={
          <>
            Registered vault: <a href={addressUrl(current)} target="_blank" rel="noreferrer" className="break-all text-violet underline">{current} ↗</a>.
            {" "}Depositors can call withdraw() and claimCubit() directly on the contract while this feature is inactive.
          </>
        }>
          {["Approve & stake", "Withdraw", "Claim rewards", "Compound rewards"].map((label) => (
            <button key={label} type="button" disabled className="brutal bg-ink/15 px-4 py-3 font-mono text-[12px] font-bold uppercase tracking-widest text-ink/50 disabled:cursor-not-allowed">{label}</button>
          ))}
        </ComingSoon>
      )}

      <div className={`grid gap-8 ${panel ? "lg:grid-cols-3" : ""}`}>
        <div className={panel ? "lg:col-span-2" : ""}>
          <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">How it works</h2>
          <div className="border-[3px] border-ink">
            {HOW.map((h, i) => (
              <div key={h} className={`flex gap-3 px-4 py-4 font-mono text-[12px] leading-relaxed text-ink/80 ${i > 0 ? "border-t border-dashed border-ink/25" : ""}`}>
                <span className="font-bold text-violet">{String(i + 1).padStart(2, "0")}</span>
                <span>{h}</span>
              </div>
            ))}
          </div>

          {active && (
            <>
              <div className="mt-8 grid grid-cols-2 border-[3px] border-ink md:grid-cols-4">
                <Stat label="Reward reserve" value={v ? `${fmtTokens(tokensToNumber(v.rewardReserve))}` : "—"} unit="CUBIT" first />
                <Stat label="Distributed" value={v ? fmtTokens(tokensToNumber(v.totalPaid)) : "—"} unit="CUBIT paid" />
                <Stat label="Total staked" value={v ? fmtTokens(tokensToNumber(v.totalStaked)) : "—"} unit="CUBIT" first />
                <Stat label="Your position" value={v?.position ? fmtTokens(tokensToNumber(v.position.staked)) : "—"} unit={account ? "CUBIT staked" : "connect a wallet"} last />
              </div>
              {view.error && <p role="alert" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-orange">Vault data unavailable: {view.error}</p>}

              {retired.length > 0 && (
                <div className="mt-8">
                  <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">Retired vaults</h2>
                  <p className="mb-3 font-mono text-[11px] leading-relaxed text-ink/65">
                    The team replaced the vault. A retired vault keeps its stakers' principal and its own reserve: withdraw and
                    claim there. No new deposits.
                  </p>
                  {retired.map((address) => <RetiredVault key={address} address={address} account={account} onDone={store.refresh} />)}
                </div>
              )}
            </>
          )}
        </div>

        {panel && (
          <div>
            <StakePanel view={v} active={onChain} deposits={active} account={account} store={store} onDone={afterTx} />
            <Link to="/#swap" className="brutal brutal-lift mt-4 block bg-cream px-4 py-3 text-center font-mono text-[11px] font-bold uppercase tracking-widest">Buy CUBIT →</Link>
            <Link to="/roadmap" className="brutal brutal-lift mt-3 block bg-cream px-4 py-3 text-center font-mono text-[11px] font-bold uppercase tracking-widest">See the roadmap →</Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** `active`: the contract takes deposits. `deposits`: the app offers new ones; before the public launch, a holder keeps
 *  Claim, Compound and Withdraw without the deposit button. */
function StakePanel({ view, active, deposits, account, store, onDone }: { view: VaultView | null; active: boolean; deposits: boolean; account: Address | null; store: ReturnType<typeof useStore>; onDone: (receipt?: TransactionReceipt) => void }) {
  const [amount, setAmount] = useState("");
  const tx = useTx(onDone);
  const units = parseAmount(amount);
  const p = view?.position ?? null;
  const now = view?.chainTime ?? 0n;
  const unlocked = !!p && now >= p.unlockAt;
  const elapsed = p && p.staked > 0n ? Number(now - p.lastRewardAt) : 0;
  const period = Number(view?.rewardPeriod ?? 86_400n);
  const ready = !!view && !!account && !store.wrongNetwork && !tx.busy;

  const clearOnSuccess = (ok: boolean) => ok && setAmount("");
  // One approval with no limit, for this vault only: it can only pull what its caller stakes (stake() and
  // fundRewardReserve() take from msg.sender), and every later stake or compound then needs a single transaction.
  const stakeNeedsApproval = !p || p.allowance === 0n || p.allowance < units;
  const stake = () => view && void tx.run([
    { label: "Approve CUBIT", request: async () => (p && p.allowance >= units ? null : approveRequest(CONFIG.token, view.vault, maxUint256)) },
    { label: "Stake", request: async () => stakeRequest(view.vault, units) },
  ]).then(clearOnSuccess);
  const compound = compoundPlan(p);
  const restake = () => view && compound && void tx.run([
    { label: "Approve CUBIT", request: async () => (compound.approve ? approveRequest(CONFIG.token, view.vault, maxUint256) : null) },
    { label: "Compound", request: async () => stakeRequest(view.vault, compound.amount) },
  ]);

  return (
    <Panel className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest">Stake CUBIT</h2>
        <StatusTag tone={active ? "live" : "muted"}>{active ? "Contract active" : "Deposits not active"}</StatusTag>
      </div>

      {!account ? (
        <button onClick={() => store.connect()} className="brutal brutal-lift mb-4 w-full bg-violet py-3 font-mono text-[12px] font-bold uppercase tracking-widest text-cream">Connect wallet</button>
      ) : store.wrongNetwork ? (
        <button onClick={store.switchNetwork} className="brutal brutal-lift mb-4 w-full bg-orange py-3 font-mono text-[12px] font-bold uppercase tracking-widest text-cream">Switch to Ethereum</button>
      ) : null}

      <div className="mb-4 space-y-1.5 border-l-[3px] border-ink/20 pl-3 font-mono text-[10px] uppercase tracking-wide text-ink/70">
        <Row l="Wallet CUBIT" r={p ? fmtTokens(tokensToNumber(p.wallet)) : "—"} />
        <Row l="Staked" r={p ? fmtTokens(tokensToNumber(p.staked)) : "—"} />
        <Row l="Claimable now" r={p ? fmtTokens(tokensToNumber(p.pending)) : "—"} accent="#7a9e00" />
        <Row l="Reward rate" r={view ? `${Number(view.dailyRewardBps) / 100}% / ${fmtDuration(period)}` : "—"} />
        <Row l="Reward window" r={!p || p.staked === 0n ? "—" : elapsed >= period ? "full day: claim now" : `${fmtDuration(elapsed)} of ${fmtDuration(period)}`} />
        <Row l="Unlock" r={!p || p.staked === 0n ? "—" : unlocked ? "unlocked" : `in ${fmtDuration(Number(p.unlockAt - now))} · ${fmtDate(Number(p.unlockAt))}`} />
      </div>

      <div className="mb-1 flex items-center justify-between">
        <label htmlFor="stake-amount" className="block font-mono text-[10px] uppercase tracking-widest text-ink/45">Amount (CUBIT)</label>
        <span className="flex gap-3">
          {deposits && p && p.wallet > 0n && <button onClick={() => setAmount(formatUnits18(p.wallet, 18))} className="font-mono text-[10px] font-bold uppercase text-violet hover:underline">Max wallet</button>}
          {p && p.staked > 0n && <button onClick={() => setAmount(formatUnits18(p.staked, 18))} className="font-mono text-[10px] font-bold uppercase text-violet hover:underline">Max staked</button>}
        </span>
      </div>
      <input
        id="stake-amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        inputMode="decimal"
        placeholder="0"
        className="mb-4 w-full border-[2px] border-ink bg-cream px-3 py-3 font-mono text-2xl font-bold tabular-nums outline-none focus:border-violet"
      />
      <div className="flex flex-col gap-2">
        {deposits && (
          <button
            onClick={stake}
            disabled={!ready || !active || units === 0n || !p || units > p.wallet}
            className="brutal brutal-lift bg-violet py-3 font-mono text-[12px] font-bold uppercase tracking-widest text-cream disabled:cursor-not-allowed disabled:bg-ink/15 disabled:text-ink/50"
          >
            {stakeNeedsApproval ? "Approve & stake" : "Stake"}
          </button>
        )}
        <button
          onClick={() => view && void tx.run([{ label: "Withdraw", request: async () => withdrawRequest(view.vault, units) }]).then(clearOnSuccess)}
          disabled={!ready || units === 0n || !p || units > p.staked || !unlocked}
          className="brutal brutal-lift bg-cream py-3 font-mono text-[12px] font-bold uppercase tracking-widest disabled:cursor-not-allowed disabled:bg-ink/15 disabled:text-ink/50"
        >
          Withdraw
        </button>
        <button
          onClick={() => view && void tx.run([{ label: "Claim", request: async () => claimRequest(view.vault) }])}
          disabled={!ready || !p || p.pending === 0n}
          className="brutal brutal-lift bg-lime py-3 font-mono text-[12px] font-bold uppercase tracking-widest disabled:cursor-not-allowed disabled:bg-ink/15 disabled:text-ink/50"
        >
          Claim rewards
        </button>
        <button
          onClick={restake}
          disabled={!ready || !active || !compound}
          className="brutal brutal-lift bg-cream py-3 font-mono text-[12px] font-bold uppercase tracking-widest disabled:cursor-not-allowed disabled:bg-ink/15 disabled:text-ink/50"
        >
          {compound?.approve ? "Approve & compound" : "Compound rewards"}
        </button>
      </div>
      <TxStatus tx={tx} />
      <div className="mt-4 border-l-[3px] border-violet bg-violet/10 px-3 py-3">
        <p className="font-mono text-[10px] uppercase leading-relaxed tracking-wide text-ink/70">
          Adding a deposit, compounding included, restarts the 24h lock of your whole position. The first deposit asks for
          one approval of this vault, with no limit; later deposits and compounds need one transaction. Unlock and rewards
          use the blockchain's clock.
          No return is guaranteed: when the reserve is empty, rewards stop.
        </p>
      </div>
    </Panel>
  );
}

function RetiredVault({ address, account, onDone }: { address: Address; account: Address | null; onDone: () => void }) {
  const view = usePoll((block) => publicData.vault(address, false, account, block), [address, account], 15_000);
  const tx = useTx(() => { view.refresh(); onDone(); });
  const p = view.data?.position;
  const unlocked = !!p && !!view.data && view.data.chainTime >= p.unlockAt;
  return (
    <Panel className="mb-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[11px]">
        <a href={addressUrl(address)} target="_blank" rel="noreferrer" className="break-all underline">{address} ↗</a>
        <span className="uppercase tracking-wide text-ink/60">staked {p ? fmtTokens(tokensToNumber(p.staked)) : "—"} · claimable {p ? fmtTokens(tokensToNumber(p.pending)) : "—"}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={!p || p.staked === 0n || !unlocked || tx.busy} onClick={() => p && void tx.run([{ label: "Withdraw", request: async () => withdrawRequest(address, p.staked) }])} className="brutal bg-cream px-3 py-2 font-mono text-[10px] font-bold uppercase disabled:opacity-40">Withdraw all</button>
        <button disabled={!p || p.pending === 0n || tx.busy} onClick={() => void tx.run([{ label: "Claim", request: async () => claimRequest(address) }])} className="brutal bg-lime px-3 py-2 font-mono text-[10px] font-bold uppercase disabled:opacity-40">Claim</button>
      </div>
      <TxStatus tx={tx} />
    </Panel>
  );
}

function TxStatus({ tx }: { tx: ReturnType<typeof useTx> }) {
  return (
    <>
      {tx.phase === "working" && <p role="status" className="mt-3 font-mono text-[10px] uppercase tracking-wide">{tx.label}…</p>}
      {tx.phase === "signing" && <p role="status" className="mt-3 font-mono text-[10px] uppercase tracking-wide">{tx.label}: confirm in your wallet…</p>}
      {tx.phase === "pending" && <p role="status" className="mt-3 font-mono text-[10px] uppercase tracking-wide">{tx.label}: {tx.slow ? "still pending" : "transaction pending…"}</p>}
      <SlowTransaction tx={tx} className="mt-3" />
      {tx.phase === "success" && <p role="status" className="mt-3 font-mono text-[10px] font-bold uppercase tracking-wide" style={{ color: "#7a9e00" }}>Confirmed ✓</p>}
      {tx.error && <p role="alert" className="mt-3 break-words font-mono text-[10px] uppercase tracking-wide text-orange">{tx.error}</p>}
      {tx.hash && <a href={txUrl(tx.hash)} target="_blank" rel="noreferrer" className="mt-2 block font-mono text-[10px] uppercase tracking-widest text-violet underline">View transaction ↗</a>}
    </>
  );
}

function Row({ l, r, accent }: { l: string; r: string; accent?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{l}</span>
      <span className="text-right font-bold tabular-nums" style={{ color: accent }}>{r}</span>
    </div>
  );
}

function Stat({ label, value, unit, first, last }: { label: string; value: string; unit: string; first?: boolean; last?: boolean }) {
  return (
    <div className={`px-4 py-5 ${first ? "border-r-[3px] border-ink" : ""} ${!last ? "border-b-[3px] border-ink md:border-b-0 md:border-r-[3px]" : ""}`}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink/45">{label}</p>
      <p className="mt-2 break-all font-mono text-base font-bold tabular-nums sm:text-lg">{value}</p>
      <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink/40">{unit}</p>
    </div>
  );
}
