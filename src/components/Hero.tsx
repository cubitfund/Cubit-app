// Hero — home section 1: headline "EVERY SALE BUILDS A WALL." (WALL in a
// lime block), CTAs, the "fixed 21M supply · v4 hook · 12% sell tax" strip, and the
// live SwapWidget on the right. "WALL" is lime because lime = wall support / positive.
import { Link } from "react-router";
import type { ProtocolState } from "../store";
import { SwapWidget } from "./SwapWidget";

export function Hero({ store }: { store: ProtocolState }) {
  return (
    <section id="top" className="mx-auto grid max-w-[1400px] items-center gap-10 px-4 py-14 md:px-8 md:py-20 lg:min-h-[calc(100vh-64px)] lg:grid-cols-2">
      {/* left */}
      <div>
        <h1 className="font-display text-[clamp(2.6rem,8.5vw,7rem)] uppercase">
          <span className="block">Every sale</span>
          <span className="block">builds a</span>
          <span className="mt-2 inline-block">
            <span className="brutal inline-block bg-lime px-4 py-1">Wall.</span>
          </span>
        </h1>

        <p className="mt-8 max-w-md font-mono text-[13px] leading-relaxed text-ink/75">
          A Uniswap v4 market where 12% of every sale is placed as an ETH buy wall under the price — by the sale itself,
          in the same transaction. No operator, no keeper, no admin key. Walls never move: new money builds new levels
          or thickens existing ones.
        </p>

        <div className="mt-8 flex flex-wrap gap-4">
          <a href="#swap" className="brutal brutal-lift bg-violet px-6 py-3 font-mono text-sm font-bold uppercase tracking-widest text-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            {store.marketOpen === false ? "Market coming soon" : "Buy cubit →"}
          </a>
          <Link to="/proof" className="brutal brutal-lift bg-cream px-6 py-3 font-mono text-sm font-bold uppercase tracking-widest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet">
            Open the proof of walls →
          </Link>
        </div>

        <p className="mt-8 font-mono text-[10px] uppercase tracking-widest text-ink/50">
          Fixed 21M supply · Uniswap v4 hook · walls funded by the 12% sell tax
        </p>
      </div>

      {/* right — swap ticket */}
      <div id="swap" className="lg:pl-6">
        <SwapWidget store={store} />
      </div>
    </section>
  );
}
