// Footer — the deployed token address (Ethereum), link columns, giant wordmark, and the honesty strapline
// ("fixed 21M supply · walls never move, they only thicken · the hook has no administrator").
import { Link } from "react-router";
import { CONFIG, tokenUrl } from "../chain/config";

const LINKS = [
  { label: "X", to: "/" },
  { label: "Telegram", to: "/" },
  { label: "DexScreener", to: "/" },
  { label: "Yellow paper", to: "/" },
];

export function Footer() {
  return (
    <footer id="footer" className="border-t-[3px] border-ink pt-14">
      <div className="mx-auto max-w-[1400px] px-4 md:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[11px] uppercase tracking-widest text-ink/50">contract · ethereum</span>
          <a
            href={tokenUrl(CONFIG.token)}
            target="_blank"
            rel="noreferrer"
            className="max-w-full break-all border-[2px] border-ink px-2 py-1 font-mono text-[11px] tracking-wide hover:bg-paper"
          >
            {CONFIG.token}
          </a>
          <Link to="/proof#verify" className="font-mono text-[11px] uppercase tracking-widest text-violet hover:underline">
            Verify everything →
          </Link>
        </div>

        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-widest">
          {LINKS.map((l) => (
            <Link key={l.label} to={l.to} className="border-b-2 border-transparent pb-0.5 hover:border-violet hover:text-violet">
              {l.label}
            </Link>
          ))}
          <a href={tokenUrl(CONFIG.token)} target="_blank" rel="noreferrer" className="border-b-2 border-transparent pb-0.5 hover:border-violet hover:text-violet">
            Etherscan ↗
          </a>
        </div>

        <div className="mt-4 overflow-hidden">
          <span className="font-display block select-none text-[clamp(4rem,26vw,22rem)] leading-[0.8] text-ink lowercase">
            cubit<span className="ml-2 inline-block h-[0.12em] w-[0.12em] bg-violet align-baseline" />
          </span>
        </div>

        <p className="border-t-[3px] border-ink py-6 font-mono text-[11px] uppercase tracking-widest text-ink/60">
          Fixed 21M supply · walls never move, they only thicken · the hook has no administrator
        </p>
      </div>
    </footer>
  );
}
