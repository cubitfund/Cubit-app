import type { BlockSnapshot } from "./readContext.ts";

/** Bound accidental polling extremes; current consumers range from 8 to 60 seconds. */
export const MIN_BLOCK_POLL_MS = 1_000;
export const MAX_BLOCK_POLL_MS = 60_000;

type Subscriber = { listener: () => void; intervalMs: number };
// A source transition may replace data at the same hash, without bypassing a consumer's cadence.
export type ClockBlock = BlockSnapshot & { source?: "shared" | "direct" };

/** One head detector, paced by its fastest subscriber. Each consumer still gates its own data reads. */
export class BlockClock {
  block: ClockBlock | null = null;
  error: unknown = null;
  private listeners = new Set<Subscriber>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private intervalMs: number | null = null;
  private pending: Promise<ClockBlock | null> | null = null;
  private visible = true;
  private read: () => Promise<ClockBlock>;
  constructor(read: () => Promise<ClockBlock>) { this.read = read; }

  subscribe(listener: () => void, intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("Block polling cadence must be positive and finite.");
    const subscriber = { listener, intervalMs: Math.max(MIN_BLOCK_POLL_MS, Math.min(MAX_BLOCK_POLL_MS, intervalMs)) };
    this.listeners.add(subscriber);
    this.reschedule();
    return () => {
      this.listeners.delete(subscriber);
      this.reschedule();
    };
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.reschedule();
  }

  refresh(): Promise<ClockBlock | null> {
    if (!this.visible || !this.listeners.size) return Promise.resolve(null);
    if (this.pending) return this.pending;
    this.pending = this.read().then((block) => {
      this.block = block;
      this.error = null;
      return block;
    }, (error: unknown) => { this.error = error; return null; }).finally(() => {
      this.pending = null;
      if (this.visible) for (const { listener } of this.listeners) listener();
    });
    return this.pending;
  }

  private reschedule() {
    const next = this.visible && this.listeners.size
      ? Math.min(...[...this.listeners].map((s) => s.intervalMs)) : null;
    if (next === this.intervalMs) return;
    const wasRunning = this.intervalMs !== null;
    clearInterval(this.timer);
    this.timer = undefined;
    this.intervalMs = next;
    if (next === null) return;
    // Joining/leaving an already active clock changes its timer without creating another immediate head read.
    if (!wasRunning) void this.refresh();
    this.timer = setInterval(() => void this.refresh(), next);
  }
}
