import { VerifySnapshot } from "../components/VerifySnapshot";
// Proof — the public "Proof of Walls" dashboard, LIVE on Ethereum. Every metric derives from one read of the
// contracts per refresh (Lens, the hook's walls, the registry) and the indexed events. Vocabulary: the Band (single
// position, 80% of supply), walls (fixed, finite, thicken), pending wall funds, Vault reward reserve, absorbed → Vault.
// Absorbed CUBIT is NOT burned — supply stays 21M. "Verify everything" lists the deployed addresses, the runtime
// bytecode hashes the deployment verifier recorded, and the modules the registry names now (the team can replace them).
import { useState } from "react";
import { useStore } from "../Root";
import { type EventKind, type ProtocolEvent, type ProtocolState, type Wall } from "../store";
import { CONFIG, addressUrl, sameAddress, txUrl } from "../chain/config";
import { dataClient } from "../chain/appChain";
import { fmtEth, fmtEthAmount, fmtInt, shortHash, timeAgo } from "../format";
import { Kpi, MOBILE_ROWS, Panel, Pill, SectionTitle, ShowAllRows } from "../components/primitives";
import { PriceWallChart } from "../components/PriceWallChart";

const KIND_COLOR: Record<EventKind, string> = {
  WALL_PLACED: "#7a9e00",
  ABSORPTION: "#5b4bff",
  DELIVERED: "#5b4bff",
  BUY: "#111312",
  SELL: "#111312",
  BAND: "#111312",
  TEAM: "#11131288",
};

const KIND_GLYPH: Record<EventKind, string> = {
  WALL_PLACED: "▲",
  ABSORPTION: "◆",
  DELIVERED: "→",
  SELL: "▼",
  BUY: "•",
  BAND: "▬",
  TEAM: "·",
};

type Filter = "ALL" | "WALL_PLACED" | "ABSORPTION" | "BUY" | "SELL";
const FILTERS: Filter[] = ["ALL", "WALL_PLACED", "ABSORPTION", "BUY", "SELL"];
const FILTER_LABEL: Record<Filter, string> = { ALL: "ALL", WALL_PLACED: "WALL PLACED", ABSORPTION: "ABSORPTION", BUY: "BUY", SELL: "SELL" };
const FILTER_KINDS: Record<Filter, EventKind[] | null> = {
  ALL: null, WALL_PLACED: ["WALL_PLACED"], ABSORPTION: ["ABSORPTION", "DELIVERED"], BUY: ["BUY"], SELL: ["SELL"],
};

const HOW = [
  { n: "01", t: "You sell", b: "15% tax on sells: 12% funds a wall, 3% team. Buys are taxed 3% (team)." },
  { n: "02", t: "The sale places the wall", b: "The same transaction that pays the tax places an ETH-only buy position at a fixed formula target (0.4 × current price + 0.6 × launch price), or 1% under the price at or below launch. No keeper, no operator. Once placed, a wall never moves from its tick; new funds on the same tick thicken it." },
  { n: "03", t: "Absorption", b: "When a dump reaches a wall, the wall spends its ETH buying CUBIT. If fully crossed, its CUBIT goes to the Vault reward reserve (it is not burned — supply stays 21M) and the ETH it releases returns to pending funds. If partially consumed, the wall stays and refills with ETH if price recovers." },
  { n: "04", t: "Finite support", b: "Each wall holds finite ETH; its level and its remaining depth are two different numbers, both shown below. At launch there are no walls: they exist because people trade." },
];

const STATUS_LABEL: Record<Wall["status"], string> = { active: "active", partial: "partially consumed", crossed: "crossed" };
const STATUS_COLOR: Record<Wall["status"], string> = { active: "#7a9e00", partial: "#5b4bff", crossed: "#11131255" };

export function Proof() {
  const store = useStore();
  const { d, core, market } = store;
  const [filter, setFilter] = useState<Filter>("ALL");
  const [allWalls, setAllWalls] = useState(false);
  const kinds = FILTER_KINDS[filter];
  const feed = kinds ? store.feed.filter((e) => kinds.includes(e.kind)) : store.feed;
  const next = core.nextWall;

  if (!market) return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      <SectionTitle eyebrow="Proof of walls" title="CUBIT on Ethereum." />
      <p role="status" className="mt-6 font-mono text-[12px]">
        {store.marketOpen === false ? "The market is not open yet. Deployed contracts are listed below."
          : "Reading the market…"}
      </p>
      <VerifyContracts store={store} />
    </div>
  );

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      {/* header */}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b-[3px] border-ink pb-6">
        <SectionTitle eyebrow="Proof of walls" title="The walls are working." />
        <div className="flex items-center gap-2 border-[2px] border-ink px-3 py-2">
          <span className={`h-2 w-2 ${store.error ? "bg-orange" : "animate-pulse bg-lime"}`} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink/60">
            Live · Uniswap v4 · Ethereum mainnet{core.block ? ` · block ${fmtInt(core.block)}` : ""}{store.updatedAt ? ` · ${timeAgo(store.updatedAt)}` : ""}
          </span>
        </div>
      </div>
      <p className="mb-8 max-w-2xl font-mono text-[12px] leading-relaxed text-ink/65">
        {dataClient
          ? "These figures describe contract state at the displayed Ethereum block. Use Verify on chain to compare the snapshot with the public RPC. Walls are finite support, not a guarantee. Supply never decreases."
          : "The canonical public proof that the mechanism works. Every value below is read from the contracts on Ethereum at one block — nothing is hardcoded. Walls are finite support, not a guarantee. Supply never decreases."}
      </p>

      {dataClient && <VerifySnapshot market={market} />}

      {/* headline stats */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-1">
          <Kpi label="ETH in walls (live support)" value={`${fmtEthAmount(d.ethInWalls)} ETH`} unit={`${fmtEthAmount(core.pendingWallETH)} ETH pending placement`} accent="#7a9e00" emphatic tick />
        </Panel>
        <Panel className="lg:col-span-2">
          <div className="grid grid-cols-2 divide-ink md:grid-cols-3">
            <div className="border-b-[3px] border-r-[3px] border-ink md:border-b-0"><Kpi label="Active walls" value={fmtInt(d.activeWalls)} unit={`${d.partialWalls} partially consumed · ${d.crossedWalls} crossed`} accent="#7a9e00" tick /></div>
            <div className="border-b-[3px] border-ink md:border-b-0 md:border-r-[3px]"><Kpi label="Top wall support" value={d.topWallLevel ? fmtEth(d.topWallLevel) : "—"} unit="ETH · highest standing wall" /></div>
            <div className="col-span-2 md:col-span-1"><Kpi label="Market price" value={core.priceUnavailable ? "—" : fmtEth(core.marketPriceETH)} unit={`${fmtEthAmount(d.marketFDVETH)} ETH FDV · ${d.priceVsLaunch.toFixed(2)}× launch`} accent="#5b4bff" /></div>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-2 border-[3px] border-ink md:grid-cols-3 lg:grid-cols-6">
        <StatCell label="Active walls" value={fmtInt(d.activeWalls)} />
        <StatCell label="ETH in walls" value={fmtEthAmount(d.ethInWalls)} unit="ETH" />
        <StatCell label="Pending wall funds" value={fmtEthAmount(core.pendingWallETH)} unit="ETH" accent="#5b4bff" />
        <StatCell label="CUBIT absorbed → Vault reserve" value={fmtInt(core.absorbedToVault)} unit={`CUBIT · ${fmtInt(core.pendingAbsorbed)} awaiting delivery`} />
        <StatCell label="Band composition" value={`${(core.bandCubit / 1_000_000).toFixed(2)}M / ${fmtEthAmount(core.bandETH)}`} unit="CUBIT / ETH" />
        <StatCell label="Circulating supply" value={fmtInt(core.circulatingSupply)} unit={`Lens · of ${fmtInt(core.totalSupply)} fixed`} />
      </div>

      {/* how it works */}
      <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {HOW.map((h) => (
          <div key={h.n} className="brutal ticket flex flex-col bg-cream p-5">
            <span className="font-mono text-sm font-bold text-violet">{h.n}</span>
            <h3 className="mt-2 font-display text-lg uppercase leading-tight">{h.t}</h3>
            <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink/70">{h.b}</p>
          </div>
        ))}
      </div>

      {/* chart */}
      <div className="mt-10">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">Market price vs wall support</h2>
        <Panel className="p-3 md:p-5">
          <PriceWallChart series={store.series} height={400} />
        </Panel>
      </div>

      {/* walls table + placement formula */}
      <div className="mt-10 grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">Walls under the price</h2>
          <Panel>
            <div className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-x-3 border-b-[2px] border-ink px-4 py-2 font-mono text-[9px] uppercase tracking-widest text-ink/50">
              <span>Level (ETH)</span><span className="text-right">ETH remaining</span><span className="text-right">CUBIT held</span><span className="text-right">Status</span>
            </div>
            {core.walls.length === 0 && (
              <div className="px-4 py-6 font-mono text-[11px] text-ink/45">{store.loading ? "Reading the walls…" : "No wall yet: the first sale places one."}</div>
            )}
            {core.walls.map((w, i) => (
              <div key={w.id} className={`${i >= MOBILE_ROWS && !allWalls ? "hidden md:grid" : "grid"} grid-cols-[1.4fr_1fr_1fr_auto] items-center gap-x-3 border-b border-dashed border-ink/25 px-4 py-3 font-mono text-[11px] last:border-b-0`}>
                <span className="tabular-nums font-bold">{fmtEth(w.level)} <span className="font-normal text-ink/40">#{w.wallId}</span></span>
                <span className="text-right tabular-nums">{fmtEthAmount(w.ethRemaining)}</span>
                <span className="text-right tabular-nums text-ink/70">{w.cubitHeld ? fmtInt(w.cubitHeld) : "—"}</span>
                <span className="text-right text-[9px] font-bold uppercase tracking-wide" style={{ color: STATUS_COLOR[w.status] }}>{STATUS_LABEL[w.status]}</span>
              </div>
            ))}
            {core.walls.length > MOBILE_ROWS && !allWalls && <ShowAllRows total={core.walls.length} onClick={() => setAllWalls(true)} />}
          </Panel>
        </div>

        <Panel className="p-5">
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest">Wall placement</h2>
          <p className="mt-4 font-mono text-[11px] uppercase tracking-wide text-ink/60">target = 0.4 · market + 0.6 · launch</p>
          <div className="mt-4 space-y-2 font-mono text-[11px] tabular-nums">
            <div className="flex justify-between"><span className="text-ink/60">market</span><span className="font-bold">{core.priceUnavailable ? "—" : fmtEth(core.marketPriceETH)}</span></div>
            <div className="flex justify-between"><span className="text-ink/60">launch</span><span className="font-bold">{fmtEth(core.launchPriceETH)}</span></div>
            <div className="mt-2 flex justify-between border-t-2 border-dashed border-ink/25 pt-2">
              <span className="text-ink/60">next wall target</span>
              <span className="font-bold" style={{ color: "#7a9e00" }}>{next ? fmtEth(next.level) : "—"}</span>
            </div>
            {next?.underMarket && <p className="text-[10px] uppercase tracking-wide text-violet">At or below launch: 1% under the price.</p>}
          </div>
          <p className="mt-4 border-t-2 border-dashed border-ink/25 pt-3 font-mono text-[10px] uppercase leading-relaxed tracking-wide text-ink/60">
            A wall never moves from its tick. New funds on the same tick thicken it. Crossed CUBIT flows to the Vault
            reserve — it is not burned. The target is computed on the price the sale leaves.
          </p>
        </Panel>
      </div>

      {/* event feed */}
      <div className="mt-10">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-xs font-bold uppercase tracking-widest">Protocol event feed</h2>
          <div className="flex flex-wrap">
            {FILTERS.map((k, i) => (
              <Pill key={k} active={filter === k} onClick={() => setFilter(k)} className={i > 0 ? "border-l-0" : ""}>{FILTER_LABEL[k]}</Pill>
            ))}
          </div>
        </div>
        <Panel>
          {feed.length === 0 && <div className="px-4 py-6 font-mono text-[11px] text-ink/40">No {FILTER_LABEL[filter].toLowerCase()} events yet.</div>}
          {feed.map((e) => (
            <FeedRow key={e.id} e={e} />
          ))}
        </Panel>
      </div>

      <VerifyContracts store={store} />
    </div>
  );
}

function VerifyContracts({ store }: { store: ProtocolState }) {
  const { market, core, modules } = store;
  const hashes = [...CONFIG.runtimeCodeHashes, ...CONFIG.launchpadRuntimeCodeHashes];
  const forge = modules?.forge ?? CONFIG.forge;
  return (
    <div id="verify" className="mt-10 scroll-mt-24">
      <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest">Verify everything</h2>
      <Panel>
        <VerifyRow label="Token (CUBIT)" address={CONFIG.token} />
        <VerifyRow label="Hook — the only liquidity provider" address={CONFIG.hook} />
        <VerifyRow label="Pool ID" value={CONFIG.poolId} href={addressUrl(CONFIG.poolManager)} note="Uniswap v4 PoolManager" />
        <VerifyRow label="The Band position" value={market ? `ticks ${market.band.lower} → ${market.band.upper}` : "—"} href={addressUrl(CONFIG.hook)} note={market ? `${fmtInt(core.bandCubit)} CUBIT · ${fmtEthAmount(core.bandETH)} ETH` : undefined} />
        <VerifyRow label="Vault · reward reserve" address={modules?.vault ?? CONFIG.vault} note={market ? `${fmtInt(core.rewardReserve)} CUBIT in reserve` : undefined} replaced={!!modules && !sameAddress(modules.vault, CONFIG.vault)} />
        <VerifyRow label="Registry (CubitV2)" address={CONFIG.v2} note={modules ? `features ${store.features.flags} · module revision ${modules.revision}` : undefined} />
        <VerifyRow label="Router" address={modules?.router ?? CONFIG.router} replaced={!!modules && !sameAddress(modules.router, CONFIG.router)} />
        <VerifyRow label="Lens" address={modules?.lens ?? CONFIG.lens} replaced={!!modules && !sameAddress(modules.lens, CONFIG.lens)} />
        <VerifyRow label="Launchpad (Forge)" address={/^0x0{40}$/i.test(forge) ? null : forge} value="Not registered" replaced={!!modules && !/^0x0{40}$/i.test(forge) && !sameAddress(forge, CONFIG.forge)} />
        <VerifyRow label="Launchpad governance vault" address={/^0x0{40}$/i.test(CONFIG.governanceVault) ? null : CONFIG.governanceVault} value="Not deployed" />
        <VerifyRow label="Launcher (one-shot)" address={CONFIG.launch} />
        <VerifyRow label="Team address (immutable)" address={CONFIG.teamAddress} />
      </Panel>

      {hashes.length > 0 && <>
        <h3 className="mb-3 mt-8 font-mono text-xs font-bold uppercase tracking-widest">Source / bytecode</h3>
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left font-mono text-[10px] tabular-nums">
              <thead>
                <tr className="border-b-[2px] border-ink uppercase tracking-widest text-ink/50">
                  <th className="px-4 py-2 font-normal">Contract</th>
                  <th className="px-4 py-2 font-normal">Address</th>
                  <th className="px-4 py-2 font-normal">Runtime keccak256 (verified against the build)</th>
                </tr>
              </thead>
              <tbody>
                {hashes.map((h) => (
                  <tr key={h.address} className="border-b border-dashed border-ink/25 last:border-b-0">
                    <td className="px-4 py-2 font-bold">{h.contract}</td>
                    <td className="px-4 py-2">
                      <a className="underline hover:text-violet" href={addressUrl(h.address)} target="_blank" rel="noreferrer">{shortHash(h.address)} ↗</a>
                      <a className="ml-2 text-violet underline" href={`${addressUrl(h.address)}#code`} target="_blank" rel="noreferrer">source</a>
                    </td>
                    <td className="break-all px-4 py-2 text-ink/70">{h.keccak256}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </>}
      <p className="mt-3 max-w-2xl font-mono text-[10px] uppercase leading-relaxed tracking-wide text-ink/45">
        {hashes.length === 0 && "Runtime verification hashes are not included in this deployment record. "}
        The hook itself has no admin. The team retains permanent power
        to replace peripheral modules (Vault, Router, Lens, Forge) and to activate features; the hook, the Band and the
        wall logic cannot be altered. {modules ? "Modules above are read live from the registry." : "Module addresses come from the deployment record while the registry is unavailable."}
      </p>
    </div>
  );
}

function StatCell({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="border-b-[3px] border-ink px-4 py-4 md:border-r-[3px] md:[&:nth-child(3n)]:border-r-0 md:[&:nth-child(n+4)]:border-b-0 lg:border-b-0 lg:[&:nth-child(3n)]:border-r-[3px] lg:[&:nth-child(6n)]:border-r-0">
      <p className="font-mono text-[9px] uppercase tracking-widest text-ink/45">{label}</p>
      <p className="mt-1.5 font-mono text-[13px] font-bold tabular-nums [overflow-wrap:anywhere] sm:text-base" style={{ color: accent }}>{value}</p>
      {unit && <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink/40">{unit}</p>}
    </div>
  );
}

function VerifyRow({ label, address, value, href, note, replaced }: { label: string; address?: string | null; value?: string; href?: string; note?: string; replaced?: boolean }) {
  const shown = address ?? value ?? "—";
  const link = address ? addressUrl(address) : href;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-dashed border-ink/25 px-4 py-3 font-mono text-[11px] last:border-b-0">
      <span className="uppercase tracking-wide text-ink/70">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        {note && <span className="text-[9px] uppercase tracking-widest text-ink/45">{note}</span>}
        {replaced && <span className="border-[2px] border-ink bg-orange px-1.5 text-[9px] font-bold uppercase text-cream">replaced by the team</span>}
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="break-all border-[2px] border-ink px-2 py-0.5 text-[10px] hover:bg-paper">{shown} ↗</a>
        ) : (
          <span className="break-all border-[2px] border-ink px-2 py-0.5 text-[10px]">{shown}</span>
        )}
      </span>
    </div>
  );
}

function FeedRow({ e }: { e: ProtocolEvent }) {
  return (
    <a
      href={txUrl(e.tx)}
      target="_blank"
      rel="noreferrer"
      className="slide-in flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-ink/25 px-4 py-3 font-mono text-[11px] last:border-b-0 hover:bg-paper"
    >
      <span className="w-4 shrink-0 text-center" style={{ color: KIND_COLOR[e.kind] }}>{KIND_GLYPH[e.kind]}</span>
      <span className="w-32 shrink-0 font-bold uppercase tracking-wide">{e.headline}</span>
      <span className="min-w-0 flex-1 truncate tabular-nums text-ink/80">{e.detail}</span>
      <span className="shrink-0 text-ink/40">blk {fmtInt(e.block)}</span>
      <span className="hidden shrink-0 text-ink/35 md:inline">{timeAgo(e.ts)}</span>
      <span className="hidden shrink-0 text-ink/35 sm:inline">{shortHash(e.tx)}</span>
      <span className="shrink-0 text-ink/30">↗</span>
    </a>
  );
}
