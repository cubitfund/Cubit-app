import { CUBIT } from "../chain/appChain";
// SwapWidget — buy/sell interface, LIVE on Ethereum. Quotes come from the Uniswap v4 quoter, so the hook's taxes are
// inside every figure; transactions are real. CUBIT trades through the registry's CubitRouter (it delivers the CUBIT
// crossed walls absorb in the same transaction); a launchpad token trades through the canonical Universal Router.
// Tax model: BUY 3% → team (no wall). SELL 15% = 12% → wall + 3% → team. A launchpad v2 token trades against its own
// quote (ETH, USDC, USDT, WBTC or a tokenized stock) with the taxes its launcher chose: the widget shows those. Such a
// token with an ERC-20 pair can also be bought with ETH: the Universal Router swaps the ETH to the pair on Uniswap v3,
// then buys the token, in one transaction (ethRoute.ts).
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import type { ProtocolState } from "../store";
import { CONST } from "../store";
import { type MarketRef } from "../chain/market";
import { formatUnits18, formatUnitsDec, minOut, parseSlippage, tokensToNumber, unitsToNumber, weiToEth } from "../chain/math";
import { CONFIG, txUrl } from "../chain/config";
import { SlowTransaction } from "./primitives";
import { useSwap } from "../chain/useSwap";
import { describePath } from "../chain/ethRoute";
import { fmtEth, fmtEth8, fmtEthAmount, fmtTokens } from "../format";
import { Sparkle } from "../ui";

const GAS_RESERVE_WEI = 3_000_000_000_000_000n; // keep 0.003 ETH for gas when using MAX on a buy

type SwapWidgetProps = {
  store: ProtocolState;
  market?: MarketRef;
  /** Defaults to the registry's router for CUBIT; launchpad tokens use the Universal Router. */
  router?: Address | null;
  /** Where the next sale's wall goes at today's price; defaults to CUBIT's. */
  nextWall?: { level: number; underMarket: boolean } | null;
};

export function SwapWidget(props: SwapWidgetProps) {
  const { store, market = CUBIT } = props;
  const opened = useRef(false);
  useEffect(() => { if (store.marketOpen === true) opened.current = true; }, [store.marketOpen]);
  // Do not mount quote, balance or transaction hooks before a successful read confirms the CUBIT pool is open.
  // Once mounted, keep receipt tracking alive through a later data outage.
  if (market.parent && store.marketOpen !== true && !opened.current) return (
    <div className="brutal ticket bg-cream p-5 md:p-6">
      <h2 className="font-mono text-sm font-bold uppercase tracking-widest">Trade CUBIT</h2>
      <p role="status" className="mt-4 font-mono text-[12px] leading-relaxed text-ink/75">
        {store.marketOpen === false ? "The market is not open yet. Trading will be available after launch."
          : "Checking market availability…"}
      </p>
      <button disabled className="mt-5 w-full bg-ink/15 py-3 font-mono text-[12px] font-bold uppercase tracking-widest text-ink/50 disabled:cursor-not-allowed">
        {store.marketOpen === false ? "Coming soon" : "Loading…"}
      </button>
    </div>
  );
  return <LiveSwapWidget {...props} />;
}

function LiveSwapWidget({ store, market = CUBIT, router, nextWall }: SwapWidgetProps) {
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [buyEth, setBuyEth] = useState("0.01");
  const [sellAmount, setSellAmount] = useState("");
  const [showGear, setShowGear] = useState(false);
  const [slippage, setSlippage] = useState("1.0");
  // A pair other than ETH: pay with ETH (routed) by default, or with the pair itself.
  const [payEth, setPayEth] = useState(true);
  const ercPair = !market.parent && !!market.quote && market.quote.address !== "0x0000000000000000000000000000000000000000";
  const symbol = market.symbol;
  const available = !market.parent || store.marketOpen === true;
  const amount = mode === "buy" ? buyEth : sellAmount;
  const swap = useSwap({
    market,
    router: market.parent ? (router ?? store.modules?.router ?? null) : null,
    mode,
    amount,
    slippage,
    payEth: ercPair && payEth,
    enabled: available,
    onDone: store.refresh,
  });
  const wall = nextWall === undefined ? store.core.nextWall : nextWall;
  const slip = parseSlippage(slippage);
  const out = swap.quote?.out ?? null;
  // The pool's quote and taxes: ETH and CUBIT's rates unless a launchpad v2 token chose others.
  const qSym = market.quote?.symbol ?? "ETH";
  const qDec = market.quote?.decimals ?? 18;
  const buyTax = market.taxes ? market.taxes.buyTeamBps / 10_000 : CONST.BUY_TAX;
  const wallShare = market.taxes ? market.taxes.sellWallBps / 10_000 : CONST.SELL_WALL_SHARE;
  const teamShare = market.taxes ? market.taxes.sellTeamBps / 10_000 : CONST.SELL_TEAM_SHARE;
  const sellTax = market.taxes ? wallShare + teamShare : CONST.SELL_TAX;
  const pct = (x: number) => `${Math.round(x * 10_000) / 100}%`;
  const paySym = swap.viaEth ? "ETH" : qSym;
  const paid = unitsToNumber(swap.units, swap.viaEth ? 18 : qDec);
  // The buy tax is taken in the pair: with ETH, on the pair the first swap yields.
  const pairPaid = swap.viaEth ? (swap.quote?.pairIn === undefined ? null : unitsToNumber(swap.quote.pairIn, qDec)) : paid;
  const routeText = swap.viaEth && swap.quote?.route ? describePath(swap.quote.route, {
    [CONFIG.weth.toLowerCase()]: "ETH", [CONFIG.routeHub.toLowerCase()]: "USDC", [market.quote!.address.toLowerCase()]: qSym,
  }) : null;

  const received = out === null ? null : tokensToNumber(out);
  const net = out === null ? null : unitsToNumber(out, qDec);
  const gross = net === null ? null : net / (1 - sellTax);
  const floorOut = out !== null && slip !== null && out > 0n ? minOut(out, slip) : null;
  const roundTrip = market.taxes ? pct(buyTax + sellTax * (1 - buyTax)) : "17.5%";

  let label = mode === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`;
  let action: () => void = () => void swap.submit();
  let disabled = false;
  if (swap.tx.phase === "working") [label, disabled] = [`${swap.tx.label ?? "Preparing"}…`, true];
  else if (swap.tx.phase === "signing") [label, disabled] = ["Confirm in your wallet…", true];
  else if (swap.tx.phase === "pending") [label, disabled] = [swap.tx.slow ? "Still pending…" : "Transaction pending…", true];
  else if (swap.tx.phase === "success") [label, disabled] = ["Confirmed ✓", true];
  else if (!available) [label, disabled] = [store.marketOpen === false ? "Coming soon" : "Loading…", true];
  else if (store.wallet === "connecting") [label, disabled] = ["Connecting…", true];
  else if (store.wallet !== "connected") [label, action] = ["Connect wallet to swap", () => store.connect()];
  else if (swap.wrongNetwork) [label, action] = [`Switch to ${CONFIG.chainName}`, store.switchNetwork];
  else if (swap.units === 0n) [label, disabled] = [mode === "buy" ? `Enter ${paySym === "ETH" ? "an" : "a"} ${paySym} amount` : `Enter a ${symbol} amount`, true];
  else if (swap.insufficient) [label, disabled] = ["Insufficient balance", true];
  else if (swap.tooManyWalls) [label, disabled] = ["Split the sale", true];
  else if (!swap.slippageValid) [label, disabled] = ["Invalid slippage", true];
  else if (swap.routerMissing) [label, disabled] = ["Router unavailable", true];
  else if (!swap.quote) [label, disabled] = [swap.quoteError ? "No quote" : "Getting quote…", true];
  const busy = swap.tx.busy || store.wallet === "connecting";

  const setMax = () => {
    if (!swap.balances) return;
    if (mode === "sell") setSellAmount(formatUnits18(swap.balances.token, 18));
    else if (ercPair && !swap.viaEth) setBuyEth(formatUnitsDec(swap.balances.quote, qDec, qDec));
    else setBuyEth(formatUnits18(swap.balances.eth > GAS_RESERVE_WEI ? swap.balances.eth - GAS_RESERVE_WEI : 0n, 6));
  };

  return (
    <div className="brutal ticket bg-cream p-5 md:p-6">
      {/* tabs */}
      <div className="mb-5 flex">
        {(["buy", "sell"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              swap.tx.reset();
            }}
            aria-pressed={mode === m}
            className={`flex-1 border-[2px] border-ink py-2 font-mono text-[12px] font-bold uppercase tracking-widest ${mode === m ? "bg-ink text-cream" : "bg-transparent text-ink"} ${m === "buy" ? "border-r-0" : ""}`}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "buy" ? (
        <>
          {ercPair && (
            <div className="mb-3 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink/55">Pay with</span>
              {([true, false] as const).map((eth) => (
                <button key={String(eth)} onClick={() => { if (eth !== payEth) setBuyEth(""); setPayEth(eth); swap.tx.reset(); }} aria-pressed={payEth === eth}
                  className={`border-[2px] border-ink px-2 py-1 font-mono text-[10px] font-bold uppercase ${payEth === eth ? "bg-ink text-cream" : "bg-transparent text-ink"}`}>
                  {eth ? "ETH" : qSym}
                </button>
              ))}
            </div>
          )}
          <Field label={`You pay (${paySym})`} value={buyEth} onChange={setBuyEth} onMax={swap.balances ? setMax : undefined} />
          <Output label={`You receive (est. ${symbol}, net of tax)`} value={received === null ? "—" : fmtTokens(received)} unit={symbol} />

          <div className="mb-3 space-y-1 border-l-[3px] border-ink/20 pl-3 font-mono text-[10px] uppercase tracking-wide text-ink/70">
            {routeText && <Line l="route" r={routeText} />}
            {swap.viaEth && <Line l={`${qSym} bought with your ETH (≈)`} r={pairPaid === null ? "—" : `${fmtEth8(pairPaid)} ${qSym}`} />}
            <Line l={`${pct(buyTax)} buy tax → team`} r={pairPaid === null ? "—" : `${fmtEth8(pairPaid * buyTax)} ${qSym}`} />
            <Line l={`effective cost / ${symbol}`} r={received ? `${fmtEth(paid / received)} ${paySym}` : "—"} />
            <Line l="minimum received" r={floorOut === null ? "—" : `${fmtTokens(tokensToNumber(floorOut))} ${symbol}`} />
          </div>

          <GuaranteeLine text={wallShare > 0 ? `Round trip cost ≈ ${roundTrip} — this is what builds the walls.`
            : `Round trip cost ≈ ${roundTrip}. This token's sales fund no walls.`} />
        </>
      ) : (
        <>
          <Field label={`You pay (${symbol})`} value={sellAmount} onChange={setSellAmount} onMax={swap.balances ? setMax : undefined} />
          <Output label={`You receive (net ${qSym}, after ${pct(sellTax)} tax)`} value={net === null ? "—" : fmtEth8(net)} unit={qSym} />

          <div className="mb-3 space-y-1 border-l-[3px] border-ink/20 pl-3 font-mono text-[10px] uppercase tracking-wide text-ink/70">
            <Line l="gross quote (≈)" r={gross === null ? "—" : `${fmtEth8(gross)} ${qSym}`} />
            <Line l={`${pct(wallShare)} → wall placed under the market`} r={gross === null ? "—" : `${fmtEth8(gross * wallShare)} ${qSym}`} accent="#7a9e00" />
            <Line l={`${pct(teamShare)} → team`} r={gross === null ? "—" : `${fmtEth8(gross * teamShare)} ${qSym}`} />
            <Line l="minimum received" r={floorOut === null ? "—" : `${fmtEth8(unitsToNumber(floorOut, qDec))} ${qSym}`} accent="#5b4bff" />
          </div>

          <GuaranteeLine
            text={
              wallShare === 0
                ? "This token's sales fund no walls."
                : wall
                  ? `Your ${pct(wallShare)} places ${qSym === "ETH" ? "an" : "a"} ${qSym} wall at ≈ ${fmtEth(wall.level)} ${qSym}${wall.underMarket ? " (1% under the price, at or below launch)" : ""}.`
                  : `Your ${pct(wallShare)} waits in the pending wall funds: no wall fits under the price.`
            }
          />
          {swap.tooManyWalls && <p className="mt-2 font-mono text-[10px] uppercase tracking-wide text-orange">{swap.tooManyWallsMessage}</p>}
        </>
      )}

      {swap.balances && (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-ink/55">
          Balance · {fmtEthAmount(weiToEth(swap.balances.eth))} ETH
          {qSym !== "ETH" && <> · {fmtEthAmount(unitsToNumber(swap.balances.quote, qDec))} {qSym}</>}
          {" · "}{fmtTokens(tokensToNumber(swap.balances.token))} {symbol}
        </p>
      )}

      {/* gear + swap */}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => setShowGear((g) => !g)}
          aria-label="Slippage settings"
          aria-expanded={showGear}
          className="brutal brutal-lift flex h-11 w-11 items-center justify-center bg-cream text-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet"
        >
          ⚙
        </button>
        <button
          onClick={action}
          disabled={disabled}
          className={`brutal brutal-lift flex-1 py-3 font-mono text-sm font-bold uppercase tracking-widest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed ${swap.tx.phase === "success" ? "bg-lime text-ink" : disabled ? "bg-ink/20 text-ink/60" : "bg-violet text-cream"} ${busy ? "cursor-wait opacity-80" : ""}`}
        >
          {label}
        </button>
      </div>

      {showGear && (
        <div className="mt-3 flex items-center justify-between border-[2px] border-dashed border-ink/40 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink/60">Slippage %</span>
          <input
            value={slippage}
            onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Slippage percent"
            className="w-16 border-[2px] border-ink bg-cream px-2 py-1 text-right font-mono text-xs font-bold"
          />
        </div>
      )}

      {swap.quoteError && swap.units > 0n && <p className="mt-3 break-words font-mono text-[10px] uppercase tracking-wide text-orange">{swap.quoteError}</p>}
      <SlowTransaction tx={swap.tx} className="mt-3" />
      {swap.tx.error && <p role="alert" className="mt-3 break-words font-mono text-[10px] uppercase tracking-wide text-orange">{swap.tx.error}</p>}
      {swap.tx.hash && (
        <a href={txUrl(swap.tx.hash)} target="_blank" rel="noreferrer" className="mt-2 block font-mono text-[10px] uppercase tracking-widest text-violet underline">
          View transaction ↗
        </a>
      )}

      <p className="mt-3 font-mono text-[9px] uppercase tracking-widest text-ink/35">
        Live on Ethereum mainnet · real transactions · quotes include the hook's taxes · {market.parent ? "CubitRouter" : "Uniswap Universal Router"}
      </p>
    </div>
  );
}

function Field({ label, value, onChange, onMax }: { label: string; value: string; onChange: (v: string) => void; onMax?: () => void }) {
  return (
    <>
      <div className="mb-1 flex items-center justify-between">
        <label className="block font-mono text-[10px] uppercase tracking-widest text-ink/55">{label}</label>
        {onMax && (
          <button onClick={onMax} className="font-mono text-[10px] font-bold uppercase tracking-widest text-violet hover:underline">
            Max
          </button>
        )}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        inputMode="decimal"
        placeholder="0"
        aria-label={label}
        className="mb-4 w-full border-[2px] border-ink bg-cream px-3 py-3 font-mono text-2xl font-bold tabular-nums outline-none focus:border-violet"
      />
    </>
  );
}

function Output({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-ink/55">{label}</label>
      <div className="mb-4 flex w-full items-baseline justify-between border-[2px] border-ink bg-paper px-3 py-3">
        <span className="font-mono text-2xl font-bold tabular-nums">{value}</span>
        <span className="font-mono text-xs text-ink/50">{unit}</span>
      </div>
    </>
  );
}

function Line({ l, r, accent }: { l: string; r: string; accent?: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{l}</span>
      <span className="text-right font-bold tabular-nums sm:whitespace-nowrap" style={{ color: accent }}>{r}</span>
    </div>
  );
}

function GuaranteeLine({ text }: { text: string }) {
  return (
    <div className="mb-1 flex items-center gap-2 border-l-[3px] border-lime bg-lime/15 px-3 py-2">
      <Sparkle size={12} />
      <span className="font-mono text-[10px] uppercase tracking-wide">{text}</span>
    </div>
  );
}
