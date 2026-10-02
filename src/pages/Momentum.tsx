import { CUBIT, readAllChildren } from "../chain/appChain";
// Momentum — read-only market state, LIVE: for CUBIT and every token of the launchpad, the walls standing,
// the walls the price entered and the history of broken walls, built from each hook's state and its events.
// A LENS, NOT A LEVER: it cannot withdraw wall ETH, move a band, or change a rule. The page opens when the team
// activates Momentum (feature bit 4); no contract reads that bit.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useStore } from "../Root";
import { addressUrl, sameAddress, txUrl } from "../chain/config";
import { buildSeries } from "../chain/events";
import { type MarketRef } from "../chain/market";
import { tokensToNumber, wadToNumber, weiToEth } from "../chain/math";
import { useMarket } from "../chain/useMarket";
import { usePoll } from "../chain/usePoll";
import { toWall } from "../store";
import { fmtEth, fmtEthAmount, fmtInt, fmtTokens, shortHash, timeAgo } from "../format";
import { ComingSoon, MOBILE_ROWS, Panel, Pill, ShowAllRows, StatusTag } from "../components/primitives";
import { PriceWallChart } from "../components/PriceWallChart";

const ETHEREUM_BLOCK_MS = 12_000;

export function Momentum() {
  const store = useStore();
  const [params, setParams] = useSearchParams();
  // Tokens from all registered Forges; each cursor replaces its reorg window on refresh.
  const children = usePoll((block) => readAllChildren(block), [store.modules?.forge], 30_000, true, true);
  const refs: MarketRef[] = useMemo(() => [CUBIT, ...(children.data ?? [])], [children.data]);
  const wanted = params.get("token");
  useEffect(() => {
    if (wanted && children.data && !refs.some((r) => sameAddress(r.token, wanted))) setParams({});
  }, [wanted, children.data, refs, setParams]);
  const ref = refs.find((r) => sameAddress(r.token, wanted)) ?? CUBIT;
  const child = useMarket(ref.parent ? null : ref, !ref.parent);
  const market = ref.parent ? store.market : child.market;
  const history = ref.parent ? store.history : child.history;
  const error = ref.parent ? store.error : child.error;
  // Without this, a failed read of the launched tokens would show CUBIT alone as if it were the only market.
  const alert = error ?? (children.data || !children.error ? null : `Launched tokens could not be read: ${children.error}`);
  const active = store.features.momentum;

  const series = useMemo(() => {
    if (ref.parent) return store.series;
    const points = buildSeries(history, market);
    if (!market) return points;
    return points.map((p) => ({ ...p, ts: p.ts ?? market.timestamp * 1000 - (Number(market.block) - p.block) * ETHEREUM_BLOCK_MS }));
  }, [ref.parent, store.series, history, market]);

  const walls = market ? market.walls.map(toWall) : [];
  const standing = walls.filter((w) => w.status === "active").sort((a, b) => b.level - a.level);
  const entered = walls.filter((w) => w.status === "partial").sort((a, b) => b.level - a.level);
  const broken = history.events.filter((e) => e.kind === "ABSORPTION").slice().reverse();
  const absorbed = broken.reduce((sum, e) => sum + (e.cubit ?? 0n), 0n);
  const head = market ? { block: Number(market.block), ts: market.timestamp * 1000 } : null;
  const sink = ref.parent ? "Vault reward reserve" : "governance vault";

  const stats: [string, string][] = market
    ? [
        ["Market price", market.priceUnavailable ? "—" : `${fmtEth(wadToNumber(market.priceWad))} ETH`],
        ["Band composition", `${fmtTokens(tokensToNumber(market.band.cubit))} ${ref.symbol} · ${fmtEthAmount(weiToEth(market.band.eth))} ETH`],
        ["Active walls", `${market.activeWalls + market.partialWalls} (${market.partialWalls} entered)`],
        ["ETH in walls", `${fmtEthAmount(weiToEth(market.wallEth))} ETH`],
        ["Pending funds", `${fmtEthAmount(weiToEth(market.pendingFloorEth))} ETH`],
        ["Next wall target", market.nextWall ? `${fmtEth(wadToNumber(market.nextWall.priceWad))} ETH${market.nextWall.underMarket ? " (1% under)" : ""}` : "no room under the price"],
        ["Top wall support", market.nearestWall ? `${fmtEth(wadToNumber(market.nearestWall.priceWad))} ETH` : "—"],
        [`Absorbed → ${sink}`, `${fmtTokens(tokensToNumber(absorbed))} ${ref.symbol}`],
      ]
    : [];

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4 border-b-[3px] border-ink pb-6">
        <div>
          <StatusTag tone={active ? "live" : "planned"}>{active ? "Live · read only" : "Not active"}</StatusTag>
          <h1 className="mt-3 font-display text-4xl uppercase leading-[0.9] md:text-7xl">Momentum.</h1>
          <p className="mt-4 max-w-2xl font-mono text-[13px] leading-relaxed text-ink/75">
            The state of every market, read straight from the chain: band composition, every standing wall and its
            remaining depth, the walls the price entered, the walls sales broke, pending funds, and where the next wall goes.
          </p>
        </div>
        <span className="brutal inline-block rotate-[6deg] bg-lime px-4 py-2 font-display text-xl uppercase">{active ? "Live" : "Soon"}</span>
      </div>

      {/* lens, not a lever */}
      <div className="brutal bg-ink p-7 md:p-10">
        <h2 className="font-display text-3xl uppercase text-lime md:text-5xl">A lens, not a lever.</h2>
        <p className="mt-4 max-w-2xl font-mono text-[12px] leading-relaxed text-lime/80">
          Read-only. It cannot withdraw ETH from a wall, cannot move a band, cannot change a single rule.
        </p>
      </div>

      {!active ? (
        <ComingSoon className="mt-8" />
      ) : (
        <>
          {/* token selector */}
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink/55">Market</span>
            <div className="flex flex-wrap">
              {refs.map((r, i) => (
                <Pill
                  key={r.hook}
                  active={r.hook === ref.hook}
                  onClick={() => setParams(r.parent ? {} : { token: r.token })}
                  className={i > 0 ? "border-l-0" : ""}
                >
                  {r.symbol}
                </Pill>
              ))}
            </div>
            <a href={addressUrl(ref.hook)} target="_blank" rel="noreferrer" className="font-mono text-[10px] uppercase tracking-widest text-violet underline">hook ↗</a>
            {!ref.parent && <Link to={ref.quote ? "/launchpad" : "/launchpad-v1"} className="font-mono text-[10px] uppercase tracking-widest text-violet underline">trade on the launchpad →</Link>}
          </div>
          {alert && <p role="alert" className="mt-3 font-mono text-[10px] uppercase tracking-wide text-orange">{alert}</p>}

          <div className="mt-6 grid gap-8 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">{ref.symbol} — price vs wall support</h2>
              <div className="brutal bg-cream p-3 md:p-5">
                <PriceWallChart series={series} height={320} />
              </div>
            </div>
            <div className="border-[3px] border-ink">
              {(stats.length ? stats : [["Loading", "…"] as [string, string]]).map(([l, v], i) => (
                <div key={l} className={`flex items-center justify-between gap-3 px-4 py-4 font-mono text-[11px] uppercase tracking-wide ${i > 0 ? "border-t border-dashed border-ink/25" : ""}`}>
                  <span className="text-ink/60">{l}</span>
                  <span className="text-right font-bold tabular-nums">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-10 grid gap-8 lg:grid-cols-2">
            <WallTable title="Walls standing" empty="No wall stands under the price." rows={standing.map((w) => [`#${w.wallId}`, fmtEth(w.level), `${fmtEthAmount(w.ethRemaining)} ETH`, `${fmtEthAmount(w.fundedETH)} ETH funded`])} head={["Wall", "Level (ETH)", "Depth", "Funded"]} />
            <WallTable title="Walls entered" empty="No wall is partially consumed." rows={entered.map((w) => [`#${w.wallId}`, fmtEth(w.level), `${fmtEthAmount(w.ethRemaining)} ETH left`, `${fmtTokens(w.cubitHeld)} ${ref.symbol} held`])} head={["Wall", "Level (ETH)", "Depth left", "Bought"]} />
          </div>

          <div className="mt-10">
            <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">Walls broken — history</h2>
            <Panel>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left font-mono text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b-[2px] border-ink text-[9px] uppercase tracking-widest text-ink/50">
                      <th className="px-4 py-2 font-normal">Wall</th>
                      <th className="px-4 py-2 font-normal">Level (ETH)</th>
                      <th className="px-4 py-2 text-right font-normal">Absorbed</th>
                      <th className="px-4 py-2 text-right font-normal">ETH back to pending</th>
                      <th className="px-4 py-2 text-right font-normal">When</th>
                      <th className="px-4 py-2 text-right font-normal">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {broken.length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-6 text-ink/45">No wall has been crossed on {ref.symbol} yet.</td></tr>
                    )}
                    {broken.map((e) => {
                      const wall = market?.walls[e.wallId ?? -1];
                      const ts = head ? head.ts - (head.block - e.block) * ETHEREUM_BLOCK_MS : 0;
                      return (
                        <tr key={e.id} className="border-b border-dashed border-ink/25 last:border-b-0">
                          <td className="px-4 py-2 font-bold">#{e.wallId}</td>
                          <td className="px-4 py-2">{wall ? fmtEth(wadToNumber(wall.priceWad)) : "—"}</td>
                          <td className="px-4 py-2 text-right">{fmtTokens(tokensToNumber(e.cubit ?? 0n))} {ref.symbol}</td>
                          <td className="px-4 py-2 text-right">{fmtEthAmount(weiToEth(e.ethWei ?? 0n))}</td>
                          <td className="px-4 py-2 text-right text-ink/60">blk {fmtInt(e.block)} · {timeAgo(ts)}</td>
                          <td className="px-4 py-2 text-right"><a href={txUrl(e.tx)} target="_blank" rel="noreferrer" className="underline hover:text-violet">{shortHash(e.tx)} ↗</a></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
            <p className="mt-3 font-mono text-[10px] uppercase leading-relaxed tracking-wide text-ink/45">
              A wall is broken when a sale crosses it entirely: the same sale empties it, its {ref.symbol} go to the {sink}, and the
              ETH it releases returns to the pending wall funds. A wall the price only entered stays in place.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function WallTable({ title, head, rows, empty }: { title: string; head: string[]; rows: string[][]; empty: string }) {
  const [all, setAll] = useState(false);
  return (
    // min-w-0: a grid item otherwise grows to its table's minimum width instead of letting it scroll.
    <div className="min-w-0">
      <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">{title}</h2>
      <Panel>
        <div className="overflow-x-auto">
          <div className="min-w-[460px]">
            <div className="grid grid-cols-[0.6fr_1.4fr_1fr_1.2fr] gap-x-3 border-b-[2px] border-ink px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-ink/50">
              {head.map((h, i) => <span key={h} className={i > 1 ? "text-right" : ""}>{h}</span>)}
            </div>
            {rows.length === 0 && <div className="px-4 py-6 font-mono text-[11px] text-ink/45">{empty}</div>}
            {rows.map((r, i) => (
              <div key={r[0]} className={`${i >= MOBILE_ROWS && !all ? "hidden md:grid" : "grid"} grid-cols-[0.6fr_1.4fr_1fr_1.2fr] items-center gap-x-3 border-b border-dashed border-ink/25 px-4 py-3 font-mono text-[11px] tabular-nums last:border-b-0`}>
                {r.map((c, i) => <span key={i} className={`${i === 0 ? "font-bold" : ""} ${i > 1 ? "text-right" : ""}`}>{c}</span>)}
              </div>
            ))}
          </div>
        </div>
        {rows.length > MOBILE_ROWS && !all && <ShowAllRows total={rows.length} onClick={() => setAll(true)} />}
      </Panel>
    </div>
  );
}
