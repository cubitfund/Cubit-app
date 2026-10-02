// PriceWallChart — reusable (home Chart, Proof, Momentum). Renders, from indexed swaps and wall events:
//   violet Line   = market price after each swap
//   lime Line     = top wall support (highest standing wall; can drop when crossed)
//   lime Area     = the supported zone below the top wall
// Colour semantics are fixed: lime = wall support, violet = market.
// Walls are NOT monotone — support can fall when a wall is crossed.
import { useMemo, useState } from "react";
import {
  Area,
  ComposedChart,
  Label,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Snapshot } from "../store";
import { fmtEth, fmtEthAmount } from "../format";
import { Pill } from "./primitives";

const RANGES = ["1D", "1W", "ALL"] as const;
type Range = (typeof RANGES)[number];

function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="brutal bg-cream px-3 py-2 font-mono text-[10px] uppercase">
      <div className="flex justify-between gap-6"><span className="text-ink/50">block</span><span className="font-bold tabular-nums">{p.block}</span></div>
      <div className="flex justify-between gap-6"><span className="text-violet">market</span><span className="font-bold tabular-nums">{p.price === null ? "—" : fmtEth(p.price)}</span></div>
      <div className="flex justify-between gap-6"><span style={{ color: "#7a9e00" }}>top wall</span><span className="font-bold tabular-nums">{p.support ? fmtEth(p.support) : "—"}</span></div>
      <div className="flex justify-between gap-6"><span className="text-ink/70">ETH in walls</span><span className="font-bold tabular-nums">{fmtEthAmount(p.eth)}</span></div>
    </div>
  );
}

export function PriceWallChart({
  series,
  height = 360,
}: {
  series: Snapshot[];
  height?: number;
}) {
  const [range, setRange] = useState<Range>("ALL");

  const data = useMemo(() => {
    const cutoff = range === "ALL" ? 0 : Date.now() - (range === "1D" ? 1 : 7) * 86_400_000;
    return series
      .filter((s) => range === "ALL" || (s.ts ?? 0) >= cutoff)
      .map((s, i) => ({ t: i, block: s.block, price: s.marketPriceETH, support: s.topWallLevel || null, eth: s.ethInWalls }));
  }, [series, range]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-4 font-mono text-[9px] uppercase tracking-wide" aria-hidden>
          <span className="flex items-center gap-1"><span className="h-0.5 w-4 bg-violet" />market price</span>
          <span className="flex items-center gap-1"><span className="h-1 w-4 bg-lime" />top wall support</span>
          <span className="flex items-center gap-1"><span className="h-3 w-4 bg-lime/25" />supported zone</span>
        </div>
        <div className="flex">
          {RANGES.map((r, i) => (
            <Pill key={r} active={range === r} onClick={() => setRange(r)} className={i > 0 ? "border-l-0" : ""}>
              {r}
            </Pill>
          ))}
        </div>
      </div>

      {data.length < 2 ? (
        <div style={{ height }} className="flex w-full items-center justify-center border-[2px] border-dashed border-ink/25 font-mono text-[11px] uppercase tracking-widest text-ink/45">
          {series.length === 0 ? "Loading the chain history…" : "No trade in this range yet."}
        </div>
      ) : (
        <div style={{ height }} className="w-full" role="img" aria-label={`Market price versus wall support over ${range}. The violet line is the market price; the lime staircase is the highest standing buy wall under it, which rises as sales build walls and can fall when a wall is crossed.`}>
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 22, left: 8 }}>
              <XAxis dataKey="t" tick={false} axisLine={{ stroke: "#111312", strokeWidth: 2 }} tickLine={false} height={20}>
                <Label value="TRADES & WALL EVENTS" position="insideBottom" offset={-6} style={{ fontFamily: "Martian Mono", fontSize: 9, fill: "#11131288", letterSpacing: "0.15em" }} />
              </XAxis>
              <YAxis
                domain={[0, (dataMax: number) => dataMax * 1.15]}
                width={70}
                tick={{ fontFamily: "Martian Mono", fontSize: 9, fill: "#11131288" }}
                tickFormatter={(v: number) => (v === 0 ? "0" : v.toExponential(2))}
                axisLine={{ stroke: "#111312", strokeWidth: 2 }}
                tickLine={{ stroke: "#111312" }}
              >
                <Label value="PRICE (ETH)" angle={-90} position="insideLeft" style={{ fontFamily: "Martian Mono", fontSize: 9, fill: "#11131288", letterSpacing: "0.15em", textAnchor: "middle" }} />
              </YAxis>
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#111312", strokeDasharray: "3 3" }} />
              {/* supported zone below the top wall */}
              <Area type="stepAfter" dataKey="support" stroke="none" fill="#a8d400" fillOpacity={0.18} isAnimationActive={false} connectNulls={false} />
              {/* top wall support — lime staircase (can rise or fall) */}
              <Line type="stepAfter" dataKey="support" stroke="#a8d400" strokeWidth={3} dot={false} isAnimationActive={false} connectNulls={false} />
              {/* market price — violet, volatile */}
              <Line type="monotone" dataKey="price" stroke="#5b4bff" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
