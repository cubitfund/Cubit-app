import type { BlockClock } from "./blockClock.ts";
import type { BlockSnapshot } from "./readContext.ts";

/** Poll lifecycle independent of React, so cleanup, queued refreshes and cadence can be tested with Node. */
export class PollTask<T> {
  private alive = false;
  private generation = 0;
  private busy = false;
  private busyHash = "";
  private started = 0;
  private again = false;
  private lastAt = -Infinity;
  private lastHash = "";
  private stopClock?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private options: {
    clock: BlockClock; interval: number; allowed: () => boolean; now?: () => number;
    load: (block: BlockSnapshot) => Promise<T>; publish: (data: T) => void; error: (error: unknown) => void;
  };
  constructor(options: PollTask<T>["options"]) { this.options = options; }

  start() {
    this.alive = true;
    this.stopClock = this.options.clock.subscribe(() => void this.run(), this.options.interval);
    this.timer = setInterval(() => void this.run(), this.options.interval);
    void this.run();
  }
  stop() {
    this.alive = false;
    this.generation++;
    this.again = false;
    this.stopClock?.();
    clearInterval(this.timer);
  }
  private allowed() { return this.alive && this.options.allowed(); }

  async refresh() {
    if (!this.allowed()) return;
    const started = this.started;
    await this.options.clock.refresh();
    if (this.allowed() && this.started === started) await this.run(true);
  }

  private async run(force = false) {
    if (!this.allowed()) return;
    const { clock, interval, load, publish, error } = this.options;
    if (clock.error) { this.lastHash = ""; error(clock.error); return; }
    const block = clock.block;
    if (!block) return;
    const key = `${block.hash}:${block.source ?? "direct"}`;
    const now = (this.options.now ?? Date.now)();
    if (!force && (now - this.lastAt < interval || this.lastHash === key)) return;
    if (this.busy) { this.again ||= force && this.busyHash !== key; return; }
    this.busy = true;
    this.busyHash = key;
    this.started++;
    this.lastAt = now;
    const generation = this.generation;
    try {
      const value = await load(block);
      if (this.alive && generation === this.generation) { this.lastHash = key; publish(value); }
    } catch (e) {
      if (this.alive && generation === this.generation) { this.lastHash = ""; error(e); }
    } finally {
      this.busy = false;
      const again = this.again;
      this.again = false;
      if (again && this.allowed()) void this.run(true);
    }
  }
}
