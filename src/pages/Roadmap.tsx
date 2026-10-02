// Roadmap — dependency-based phases. NO dates, no D+N countdowns, no guardian expiry, no keepers, no
// burns. Features are written before launch and activated by an explicit team transaction; the status of each phase
// is read from the registry's feature bits, never assumed.
import { Link } from "react-router";
import { useStore } from "../Root";
import { StatusTag } from "../components/primitives";
import { VAULT_PUBLIC } from "../launch";

type Phase = {
  phase: string;
  tone: "live" | "next" | "planned" | "conditional";
  status: string;
  title: string;
  points: string[];
  link?: { label: string; to: string };
};

export function Roadmap() {
  const { features } = useStore();
  const PHASES: Phase[] = [
    {
      phase: "Phase 0",
      tone: "live",
      status: "Live",
      title: "CUBIT Genesis",
      points: [
        "Fixed 21M supply.",
        "Single Band — 80% of supply, placed once, never withdrawn.",
        "Walls placed by every sale.",
        "3% buy tax / 15% sell tax.",
        "No admin on the hook.",
        "Proof of Walls dashboard.",
      ],
      link: { label: "Open the Proof of Walls →", to: "/proof" },
    },
    {
      phase: "Phase 1",
      // Open on chain, "coming soon" in the app until its public launch (launch.ts).
      tone: features.vault && VAULT_PUBLIC ? "live" : "next",
      status: features.vault && VAULT_PUBLIC ? "Live" : "Coming soon",
      title: "The Vault",
      points: [
        "Staking: 3%/day in CUBIT from a finite reserve.",
        "Fed by crossed walls.",
        "No emissions — when the reserve is empty, rewards stop.",
      ],
      link: { label: "Open the Vault →", to: "/vault" },
    },
    {
      phase: "Phase 2",
      tone: features.momentum ? "live" : "planned",
      status: features.momentum ? "Live" : "Planned",
      title: "Momentum",
      points: ["Read-only market-state page: walls standing, entered and broken, for every token.", "A lens, not a lever."],
      link: { label: "Open Momentum →", to: "/momentum" },
    },
    {
      phase: "Phase 3",
      tone: features.forge ? "live" : "conditional",
      status: features.forge ? "Live" : "Added later",
      title: "The Forge",
      points: [
        "Public launchpad: anyone launches a token by paying a launch fee.",
        "Not deployed at CUBIT's launch: added later, opened when the team decides.",
        "Every token runs CUBIT's architecture in its own pool, with the same supply; the launch value is set per pair and the taxes are chosen by the launcher within the Forge's bounds.",
        "The launch fee is paid in ETH to the governance vault and never refunded: it belongs to governance, never to CUBIT's walls.",
        "Tokens absorbed by a launched token's crossed walls also go to the governance vault.",
      ],
      link: { label: "Open the Launchpad →", to: "/launchpad" },
    },
  ];

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-12 md:px-8">
      <div className="mb-10 border-b-[3px] border-ink pb-6">
        <SectionEyebrow>Roadmap</SectionEyebrow>
        <h1 className="mt-2 font-display text-4xl uppercase md:text-7xl">Written before launch.</h1>
        <p className="mt-4 max-w-2xl font-mono text-[13px] leading-relaxed text-ink/75">
          Phases depend on conditions, not on a calendar. Features are written before launch, then enabled
          progressively.
        </p>
      </div>

      <div className="space-y-6">
        {PHASES.map((p) => (
          <div key={p.phase} className="brutal ticket bg-cream p-6 md:p-8">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-violet">{p.phase}</span>
              <StatusTag tone={p.tone}>{p.status}</StatusTag>
            </div>
            <h2 className="mt-3 font-display text-2xl uppercase md:text-4xl">{p.title}</h2>
            <ul className="mt-4 grid gap-2 md:grid-cols-2">
              {p.points.map((pt) => (
                <li key={pt} className="flex gap-2 font-mono text-[12px] leading-relaxed text-ink/75">
                  <span className="text-violet">·</span>
                  {pt}
                </li>
              ))}
            </ul>
            {p.link && (
              <Link to={p.link.to} className="brutal brutal-lift mt-5 inline-block bg-violet px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-widest text-cream">
                {p.link.label}
              </Link>
            )}
          </div>
        ))}
      </div>

      <p className="mt-8 border-t-[3px] border-ink pt-6 font-mono text-[11px] uppercase tracking-wide text-ink/60">
        Features are written before launch, then enabled by an explicit team transaction. Nothing activates by itself.
        Phases depend on conditions, not on a calendar.
      </p>
    </div>
  );
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-ink/55">{children}</p>;
}
