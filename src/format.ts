// Plain formatting helpers — kept separate from component modules so Vite Fast
// Refresh treats those modules as component-only (mixed exports break HMR hooks).

// Tiny ETH prices need many decimals; default 11 keeps the sub-micro figures.
export const fmtEth = (n: number, d = 11) => n.toFixed(d);
export const fmtEth8 = (n: number) => n.toFixed(8);
export const fmtEthShort = (n: number) => (n >= 0.01 ? n.toFixed(3) : n.toFixed(5));
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtPct = (n: number, d = 2) => `${n.toFixed(d)}%`;
export const fmtMult = (n: number) => `${n.toFixed(2)}×`;
export const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);

/** An ETH amount with the decimals its size needs (small walls hold fractions of a milli-ether). */
export const fmtEthAmount = (n: number) =>
  n === 0 ? "0" : Math.abs(n) >= 1 ? n.toFixed(3) : Math.abs(n) >= 0.001 ? n.toFixed(4) : n.toFixed(6);

/** A token amount: whole units above 1,000, a few decimals below. */
export const fmtTokens = (n: number) =>
  Math.abs(n) >= 1_000 ? fmtInt(n) : n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/** "30d", "3d 4h", "24h", "5h 12m", "42s". Under two days, hours: the vault speaks in 24h periods. */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds / 3_600);
  const h = hours % 24;
  const m = Math.floor((seconds % 3_600) / 60);
  if (d >= 2) return h ? `${d}d ${h}h` : `${d}d`;
  if (hours > 0) return m ? `${hours}h ${m}m` : `${hours}h`;
  if (m > 0) return `${m}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
}

/** A chain timestamp (seconds) as "2026-09-15 04:12 UTC". */
export const fmtDate = (unixSeconds: number) => `${new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;

export function timeAgo(ms: number, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3_600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3_600)}h ago` : `${Math.round(s / 86_400)}d ago`;
}
