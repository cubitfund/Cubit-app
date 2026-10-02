import type { ProtocolState } from "../store";
import { Ticker } from "../ui";
import { fmtEthAmount } from "../format";

// Giant hero number — total ETH parked in live walls under the price, read from the chain.
// Walls are finite support, not a guarantee.
export function HeroNumber({ store }: { store: ProtocolState }) {
  const eth = store.d.ethInWalls;
  const n = store.d.activeWalls;
  const value = store.market ? fmtEthAmount(eth) : store.loading ? "…" : "—";
  // A small wall figure has more digits (0.000194): the giant number shrinks with its length to fit a phone.
  const size = value.length <= 5 ? "text-[clamp(4.5rem,20vw,17rem)]" : value.length <= 8 ? "text-[clamp(3rem,13vw,13rem)]" : "text-[clamp(2.5rem,10vw,11rem)]";
  return (
    <section className="border-y-[3px] border-ink py-24 md:py-36">
      <div className="mx-auto max-w-[1400px] px-4 text-center md:px-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-ink/55">ETH parked in walls under the price</p>
        <div className="relative mt-6 inline-block max-w-full">
          <span className={`font-mono ${size} font-bold leading-none tracking-tighter tabular-nums`}>
            <Ticker value={value} />
          </span>
          <span className="absolute -right-2 top-4 rotate-[8deg] border-[2px] border-ink bg-lime px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest md:-right-16">
            {store.market ? n : "—"} active {n === 1 ? "wall" : "walls"}
          </span>
        </div>
        <p className="mx-auto mt-8 max-w-xl font-mono text-[12px] leading-relaxed text-ink/60">
          ETH sitting in buy walls placed by past sales. Each wall is fixed at its tick and finite in depth — real
          support, not a promise. At launch there are no walls; they exist because people trade.
        </p>
      </div>
    </section>
  );
}
