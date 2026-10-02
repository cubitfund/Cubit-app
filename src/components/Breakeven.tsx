import type { ProtocolState } from "../store";
import { fmtEth, fmtEthAmount, fmtInt } from "../format";

// Honest-disclosure band. Walls are finite support,
// not a guarantee; supply never decreases; the hook has no admin.
export function Breakeven({ store }: { store: ProtocolState }) {
  const { d, core } = store;
  return (
    <section className="mx-auto max-w-[1400px] px-4 py-16 md:px-8">
      <div className="brutal ticket bg-lime p-7 md:p-10" style={{ transform: "rotate(-1deg)" }}>
        <h3 className="font-display text-3xl uppercase md:text-5xl">Walls are finite.</h3>
        <p className="mt-4 max-w-2xl font-mono text-[12px] leading-relaxed">
          Each wall holds a finite amount of ETH. A wall&apos;s level and its remaining depth are two different numbers —
          a high wall with little ETH left is thin support. Walls are placed by trading, never by an operator, and once
          placed they never move from their tick.
        </p>

        <div className="mt-8 flex flex-wrap items-end gap-8">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink/60">Top wall support</p>
            <p className="font-mono text-2xl font-bold tabular-nums md:text-4xl">{d.topWallLevel ? fmtEth(d.topWallLevel) : "—"}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink/60">ETH in walls</p>
            <p className="font-mono text-2xl font-bold tabular-nums md:text-4xl">{store.market ? fmtEthAmount(d.ethInWalls) : "—"}</p>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-widest text-ink/60">Absorbed → Vault reserve</p>
            <p className="font-mono text-2xl font-bold tabular-nums md:text-4xl">{store.market ? fmtInt(core.absorbedToVault) : "—"}</p>
          </div>
        </div>

        <p className="mt-6 max-w-2xl font-mono text-[11px] uppercase tracking-wide">
          Fixed 21M supply · walls never move, they only thicken · the hook has no administrator.
        </p>
      </div>
    </section>
  );
}
