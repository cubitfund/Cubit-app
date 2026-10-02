// HowItWorks — home section 2: 4 steps (You sell → The sale places the wall →
// Absorption → Finite support) + the two-books strip (The Band = liquidity / The Walls =
// support). Absorption feeds the Vault, it is NOT a burn.
import { Sparkle } from "../ui";

const STEPS = [
  {
    n: "01",
    title: "You sell",
    body: "15% tax on sells: 12% funds a wall, 3% team. Buys are taxed 3% (team).",
    art: "coin",
  },
  {
    n: "02",
    title: "The sale places the wall",
    body: "The same transaction places an ETH-only buy position at a fixed target (0.4 × price + 0.6 × launch). No keeper, no operator. Once placed, a wall never moves; new funds on the same tick thicken it.",
    art: "stairs",
  },
  {
    n: "03",
    title: "Absorption",
    body: "When a dump reaches a wall, the wall spends its ETH buying CUBIT. If fully crossed, its CUBIT goes to the Vault reserve — not burned, supply stays 21M — and leftover ETH returns to pending funds.",
    art: "crash",
  },
  {
    n: "04",
    title: "Finite support",
    body: "Each wall holds finite ETH; its level and its remaining depth are two different numbers. At launch there are no walls — they exist because people trade.",
    art: "ratchet",
  },
];

function Art({ kind }: { kind: string }) {
  const common = { fill: "none", stroke: "#111312", strokeWidth: 3 } as const;
  switch (kind) {
    case "coin":
      return (
        <svg viewBox="0 0 80 60" className="h-16 w-full">
          <circle cx="40" cy="16" r="10" fill="#5b4bff" stroke="#111312" strokeWidth={3} />
          <text x="40" y="20" textAnchor="middle" fontSize="9" fill="#f5f1e8" fontFamily="monospace">C</text>
          <rect x="18" y="40" width="44" height="16" {...common} />
          <line x1="40" y1="28" x2="40" y2="40" stroke="#111312" strokeWidth={2} strokeDasharray="3 3" />
        </svg>
      );
    case "stairs":
      return (
        <svg viewBox="0 0 80 60" className="h-16 w-full">
          <path d="M8 52 H26 V40 H44 V28 H62 V16 H74" fill="none" stroke="#a8d400" strokeWidth={4} />
        </svg>
      );
    case "crash":
      return (
        <svg viewBox="0 0 80 60" className="h-16 w-full">
          <path d="M6 12 L20 34 L30 22 L42 46" fill="none" stroke="#ff704d" strokeWidth={3} />
          <rect x="50" y="20" width="24" height="34" fill="#c7ff3d" stroke="#111312" strokeWidth={3} />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 80 60" className="h-16 w-full">
          <path d="M14 44 L40 14 L66 44" fill="#c7ff3d" stroke="#111312" strokeWidth={3} />
          <circle cx="40" cy="48" r="7" fill="none" stroke="#111312" strokeWidth={3} />
        </svg>
      );
  }
}

export function HowItWorks() {
  return (
    <section id="how" className="border-t-[3px] border-ink py-20">
      <div className="mx-auto max-w-[1400px] px-5 md:px-8">
        <h2 className="font-display text-4xl uppercase md:text-6xl">How it works</h2>

        <div className="mt-10 grid gap-6 md:grid-cols-4 md:gap-0">
          {STEPS.map((st, i) => (
            <div key={st.n} className="relative flex">
              <div className="brutal ticket flex w-full flex-col bg-cream p-5">
                <span className="font-mono text-sm font-bold text-violet">{st.n}</span>
                <div className="my-3"><Art kind={st.art} /></div>
                <h3 className="font-display text-xl uppercase">{st.title}</h3>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-ink/70">{st.body}</p>
              </div>
              {i < STEPS.length - 1 && (
                <div className="hidden items-center px-2 md:flex">
                  <span className="font-display text-2xl">→</span>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* the Band vs the Walls */}
        <div className="mt-12 grid gap-8 border-t-[3px] border-ink pt-10 md:grid-cols-2">
          <div>
            <span className="inline-block border-[2px] border-ink bg-violet px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-cream">
              The Band (liquidity)
            </span>
            <p className="mt-4 max-w-md font-mono text-[12px] leading-relaxed text-ink/75">
              One single wide position holding 80% of supply — 16.8M CUBIT — placed once at launch and never withdrawn.
              No function exists to pull it.
            </p>
          </div>
          <div>
            <span className="inline-block border-[2px] border-ink bg-lime px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest">
              The Walls (support)
            </span>
            <p className="mt-4 max-w-md font-mono text-[12px] leading-relaxed text-ink/75">
              ETH-only buy positions placed by every sale, fixed at their tick, finite in depth.
              <span className="inline-flex items-center gap-1"> Finite support — not a guarantee. Supply never decreases. <Sparkle size={11} /></span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
