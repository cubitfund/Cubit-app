import { useEffect, useState, type ReactNode } from "react";

// Chunky bordered panel with hard offset shadow — the CUBIT surface primitive.
export function Panel({
  children,
  className = "",
  clip = false,
}: {
  children: ReactNode;
  className?: string;
  clip?: boolean;
}) {
  return <div className={`brutal bg-cream ${clip ? "ticket" : ""} ${className}`}>{children}</div>;
}

// KPI cell — a labelled monospace value. `accent` colors the value; `tick`
// replays the stepped tick animation whenever the value changes.
export function Kpi({
  label,
  value,
  unit,
  accent,
  tick,
  emphatic,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: string;
  tick?: boolean;
  emphatic?: boolean;
  note?: string;
}) {
  return (
    <div className="px-4 py-5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-ink/45">{label}</p>
      <p
        key={value}
        className={`mt-2 font-mono font-bold tabular-nums [overflow-wrap:anywhere] ${emphatic ? "text-xl sm:text-2xl md:text-3xl" : "text-[13px] sm:text-lg md:text-xl"} ${tick ? "tick-up" : ""}`}
        style={{ color: accent }}
      >
        {value}
      </p>
      {unit && <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-ink/40">{unit}</p>}
      {note && <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-orange">{note}</p>}
    </div>
  );
}

// Small stamp/pill for statuses and filters.
export function Pill({
  children,
  active,
  tone = "ink",
  className = "",
  ...rest
}: {
  children: ReactNode;
  active?: boolean;
  tone?: "ink" | "violet" | "lime" | "muted";
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  // 36 px tall on a phone, a comfortable thumb target; compact from md up.
  const base = "inline-flex min-h-9 items-center gap-1.5 border-[2px] border-ink px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest md:min-h-0";
  const on =
    tone === "violet" ? "bg-violet text-cream"
    : tone === "lime" ? "bg-lime text-ink"
    : tone === "muted" ? "bg-ink/10 text-ink"
    : "bg-ink text-cream";
  return (
    <button className={`${base} ${active ? on : "bg-cream text-ink"} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function StatusTag({ children, tone = "muted" }: { children: ReactNode; tone?: "live" | "next" | "planned" | "conditional" | "muted" }) {
  const map: Record<string, string> = {
    live: "bg-lime text-ink border-ink",
    next: "bg-violet text-cream border-ink",
    planned: "bg-cream text-ink border-ink",
    conditional: "bg-orange text-cream border-ink",
    muted: "bg-ink/10 text-ink/70 border-ink/40",
  };
  return (
    <span className={`inline-block border-[2px] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-widest ${map[tone]}`}>
      {children}
    </span>
  );
}

export function ComingSoon({ message, secondary, children, className = "" }: { message?: ReactNode; secondary?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role="status" className={`border-l-[3px] border-violet bg-violet/10 px-4 py-4 font-mono text-[12px] leading-relaxed text-ink/75 ${className}`}>
      <p><strong className="font-bold text-violet">Coming soon</strong> — {message ?? "This feature is deployed on chain but not activated yet. The team turns it on with a single transaction; nothing activates by itself."}</p>
      {secondary && <p className="mt-2 text-[11px]">{secondary}</p>}
      {children && <div className="mt-4 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

// A long list shows its first MOBILE_ROWS rows on a phone; the rest waits behind this button. Wider screens show
// every row and never see the button.
export const MOBILE_ROWS = 20;

export function ShowAllRows({ total, onClick }: { total: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full border-t-[2px] border-ink px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-widest hover:bg-paper md:hidden">
      Show all {total} walls ↓
    </button>
  );
}

// Skeleton block for loading states.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-ink/10 ${className}`} aria-hidden />;
}

// Section heading in the heavy grotesk.
export function SectionTitle({ eyebrow, title, className = "" }: { eyebrow?: string; title: string; className?: string }) {
  return (
    <div className={className}>
      {eyebrow && <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-ink/55">{eyebrow}</p>}
      <h2 className="mt-2 font-display text-3xl uppercase break-words sm:text-4xl md:text-6xl">{title}</h2>
    </div>
  );
}

// A transaction still not included after four minutes. It is alive and nothing here can hurry it, so the choice is
// the user's: keep waiting, or take the form back. The transaction keeps running either way, and its link stays on
// screen. Starting over is only offered where a caller has made a second send harmless.
export function SlowTransaction({ tx, onRestart, restartNote, className = "" }: {
  tx: { phase: string; slow: boolean; stopWaiting: () => void };
  onRestart?: () => void;
  restartNote?: string;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const waiting = tx.phase === "pending" && tx.slow;
  useEffect(() => { if (!waiting) setDismissed(false); }, [waiting]);
  if (!waiting || dismissed) return null;
  return (
    <div role="alert" className={`space-y-1 border-l-[3px] border-orange bg-orange/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wide ${className}`}>
      <p className="font-bold">Still not included after 4 minutes</p>
      <p className="normal-case text-ink/75">
        It is still alive on chain, and nothing here can hurry it. {restartNote ?? "Starting over gives you the form back, so you can send again yourself."}
      </p>
      <div className="flex gap-4 pt-1">
        <button type="button" className="underline" onClick={() => setDismissed(true)}>Keep waiting</button>
        <button type="button" className="underline" onClick={() => { tx.stopWaiting(); onRestart?.(); }}>Start over</button>
      </div>
    </div>
  );
}
