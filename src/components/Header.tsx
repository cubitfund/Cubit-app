// Header — global nav: PROOF · VAULT · MOMENTUM · LAUNCHPAD · ROADMAP. No CONTRACT item — addresses live
// on /proof. Shows the live "ETH in walls" ticker, the network, and the real wallet: EIP-6963 wallets are listed when
// several are installed; a wallet on another network is asked to switch to Ethereum. Mobile menu exposes every route.
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { Ticker } from "../ui";
import type { ProtocolState } from "../store";
import { fmtEthAmount } from "../format";

// Single source for the primary nav. Keep in sync with routes.tsx.
const NAV = [
  { label: "PROOF", to: "/proof" },
  { label: "VAULT", to: "/vault" },
  { label: "MOMENTUM", to: "/momentum" },
  { label: "LAUNCHPAD", to: "/launchpad" },
  { label: "ROADMAP", to: "/roadmap" },
];

function WalletButton({ store, block = false }: { store: ProtocolState; block?: boolean }) {
  const [open, setOpen] = useState(false);
  const cls = `brutal brutal-lift px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet ${block ? "w-full" : ""}`;
  if (store.wallet === "connecting")
    return <button disabled className={`${cls} cursor-wait bg-ink/20 text-ink/60`}>Connecting…</button>;
  if (store.wallet === "connected" && store.wrongNetwork)
    return <button onClick={store.switchNetwork} className={`${cls} bg-orange text-cream`}>Switch to Ethereum</button>;
  if (store.wallet === "connected")
    return (
      <button onClick={store.disconnect} className={`${cls} bg-cream`} title="Disconnect">
        {store.addressLabel} ✕
      </button>
    );
  const several = store.wallets.length > 1;
  return (
    <div className={`relative ${block ? "w-full" : ""}`}>
      <button onClick={() => (several ? setOpen((o) => !o) : store.connect())} aria-expanded={several ? open : undefined} className={`${cls} bg-violet text-cream`}>
        Connect Wallet
      </button>
      {several && open && (
        <div className="brutal absolute right-0 z-50 mt-2 w-60 bg-cream" role="menu">
          {store.wallets.map((w) => (
            <button
              key={w.uuid}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                store.connect(w.uuid);
              }}
              className="flex w-full items-center gap-2 border-b border-dashed border-ink/25 px-3 py-3 text-left font-mono text-[11px] uppercase tracking-wide last:border-b-0 hover:bg-paper"
            >
              {w.icon ? <img src={w.icon} alt="" className="h-4 w-4" /> : <span className="h-4 w-4 bg-violet" />}
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Header({ store }: { store: ProtocolState }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const healthy = !store.error && store.updatedAt !== null;

  return (
    <header className="sticky top-0 z-50 border-b-[3px] border-ink bg-cream/95 backdrop-blur-[2px]">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3 px-4 py-3 md:px-8">
        <Link to="/" className="shrink-0 font-display text-2xl lowercase leading-none" aria-label="CUBIT home">
          cubit<span className="ml-0.5 inline-block h-2 w-2 translate-y-[-1px] bg-violet align-baseline" />
        </Link>

        <nav className="hidden items-center gap-6 font-mono text-[11px] uppercase tracking-widest lg:flex">
          {NAV.map((n) => (
            <Link
              key={n.label}
              to={n.to}
              className={`border-b-2 pb-0.5 hover:border-violet hover:text-violet ${pathname === n.to ? "border-ink" : "border-transparent"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 border-[2px] border-ink px-2 py-1 sm:flex" title={store.error ?? (store.marketOpen === false ? "Market not open yet" : "Ethereum mainnet")}>
            <span className={`h-2 w-2 ${store.marketOpen === false ? "bg-violet" : healthy ? "animate-pulse bg-lime" : "bg-orange"}`} />
            <span className="font-mono text-[9px] uppercase tracking-widest text-ink/55">ethereum · {store.marketOpen === false ? "coming soon" : "eth in walls"}</span>
            <Ticker value={store.loading ? "…" : healthy && store.marketOpen ? fmtEthAmount(store.d.ethInWalls) : "—"} className="font-mono text-[11px] font-bold" />
          </div>
          <div className="hidden lg:block">
            <WalletButton store={store} />
          </div>
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label="Menu"
            className="brutal brutal-lift flex h-10 w-10 items-center justify-center bg-cream lg:hidden"
          >
            <span className="font-mono text-lg leading-none">{open ? "✕" : "≡"}</span>
          </button>
        </div>
      </div>

      {/* Only a wallet error, which answers an action the visitor just took, deserves a banner. A read that
          failed keeps the last known figures on screen; the header dot and the update time carry the state. */}
      {store.walletError && (
        <div role="status" className="border-t-[2px] border-ink bg-orange/15 px-4 py-1.5 text-center font-mono text-[10px] uppercase tracking-widest text-ink/80">
          {store.walletError}
        </div>
      )}

      {/* mobile menu — exposes every route + wallet */}
      {open && (
        <nav className="border-t-[3px] border-ink bg-cream px-4 py-4 lg:hidden">
          <div className="flex flex-col gap-2 font-mono text-sm uppercase tracking-widest">
            {[{ label: "HOME", to: "/" }, ...NAV].map((n) => (
              <Link
                key={n.label}
                to={n.to}
                onClick={() => setOpen(false)}
                className="border-[2px] border-ink px-3 py-3 hover:bg-ink hover:text-cream"
              >
                {n.label}
              </Link>
            ))}
            <div className="mt-2">
              <WalletButton store={store} block />
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}
