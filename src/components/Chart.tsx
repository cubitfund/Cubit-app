// Chart — home "instrument" section: PriceWallChart + 6 live stats
// (Active walls, ETH in walls, Pending wall funds, Absorbed → Vault, Band composition,
// Circulating supply from the Lens). Every number reads from the shared live store; none hardcoded.
import { Link } from "react-router";
import type { ProtocolState } from "../store";
import { fmtEthAmount, fmtInt } from "../format";
import { PriceWallChart } from "./PriceWallChart";
import { SectionTitle } from "./primitives";

export function Chart({ store }: { store: ProtocolState }) {
  const { d, core } = store;
  if (!store.market) return (
    <section id="chart" role="status" className="mx-auto max-w-[1400px] px-4 py-20 font-mono text-[12px] md:px-8">
      {store.marketOpen === false ? "The chart will appear when the market opens." : "Reading the market…"}
    </section>
  );
  return (
    <section id="chart" className="mx-auto max-w-[1400px] px-4 py-20 md:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <SectionTitle eyebrow="price is free · the walls are placed" title="The instrument" />
        <Link to="/proof" className="brutal brutal-lift bg-violet px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          Open the proof of walls →
        </Link>
      </div>

      <div className="brutal bg-cream p-3 md:p-5">
        <PriceWallChart series={store.series} height={420} />
      </div>

      {/* stat row */}
      <div className="mt-8 grid grid-cols-2 border-[3px] border-ink md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Active walls" value={fmtInt(d.activeWalls)} unit="live buy walls" accent="#7a9e00" />
        <Stat label="ETH in walls" value={fmtEthAmount(d.ethInWalls)} unit="ETH · live wall positions" accent="#7a9e00" />
        <Stat label="Pending wall funds" value={fmtEthAmount(core.pendingWallETH)} unit="ETH · awaiting placement" accent="#5b4bff" />
        <Stat label="Absorbed → Vault" value={fmtInt(core.absorbedToVault)} unit="CUBIT · reward reserve" />
        <Stat label="Band composition" value={`${(core.bandCubit / 1_000_000).toFixed(2)}M`} unit={`CUBIT · ${fmtEthAmount(core.bandETH)} ETH`} />
        <Stat label="Circulating supply" value={fmtInt(core.circulatingSupply)} unit="Lens · 21M − walls − reserves" />
      </div>
    </section>
  );
}

function Stat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="border-b-[3px] border-ink px-4 py-5 md:border-r-[3px] md:[&:nth-child(3n)]:border-r-0 md:[&:nth-child(n+4)]:border-b-0 lg:border-b-0 lg:[&:nth-child(3n)]:border-r-[3px] lg:[&:nth-child(6n)]:border-r-0">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink/45">{label}</p>
      <p className="mt-2 break-all font-mono text-base font-bold tabular-nums sm:text-lg md:text-xl" style={{ color: accent }}>{value}</p>
      {unit && <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink/40">{unit}</p>}
    </div>
  );
}
