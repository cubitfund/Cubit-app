// Local AIMD policy: halve on throughput refusals, add one per quiet second, up to MAX_RATE.
// Count actual starts, never reservations.
export const OUTAGE_PAUSE_MS = 30_000;
export const QUOTA_PAUSE_MS = 30_000;
export const MAX_QUOTA_PAUSE_MS = 300_000;
export const MAX_RATE = 50;
export const MAX_WAIT_MS = 1_500;

type PrivateRoute = { endpoint: "private"; waitMs: number; probe: boolean; deadline: number; epoch: number };
export type Route = { endpoint: "public" } | PrivateRoute;

export class RpcPolicy {
  rate = MAX_RATE;
  private now: () => number;
  private downUntil = 0;
  private quotaPauseMs = 0;
  private probing = false;
  private epoch = 0;
  private lastDecrease = -Infinity;
  private lastIncrease = -Infinity;
  private sent: number[] = [];
  private waiting: PrivateRoute[] = [];

  constructor(now: () => number = () => Date.now()) { this.now = now; }

  route(): Route {
    const now = this.now();
    if (this.downUntil && (now < this.downUntil || this.probing)) return { endpoint: "public" };
    const route: PrivateRoute = {
      endpoint: "private", waitMs: 0, probe: this.downUntil !== 0, deadline: now + MAX_WAIT_MS, epoch: this.epoch,
    };
    this.waiting.push(route);
    route.waitMs = this.delay(route);
    if (route.waitMs > MAX_WAIT_MS) {
      this.remove(route);
      return { endpoint: "public" };
    }
    if (route.probe) this.probing = true;
    return route;
  }

  /** Recheck just before sending. null: use public; positive: wait and recheck; zero: start recorded NOW. */
  start(route: Route): number | null {
    if (route.endpoint === "public") return null;
    if (route.epoch !== this.epoch || !this.waiting.includes(route) || (this.downUntil !== 0 && !route.probe)) {
      this.remove(route);
      return null;
    }
    const now = this.now();
    const delay = this.delay(route);
    if (now + delay > route.deadline) {
      this.remove(route);
      if (route.probe) this.probing = false;
      return null;
    }
    if (delay > 0) return delay;
    this.remove(route);
    this.sent.push(now);
    return 0;
  }

  answered(route: Route) {
    if (!this.current(route)) return;
    const now = this.now();
    this.endProbe(route);
    if (this.rate < MAX_RATE && now - this.lastDecrease >= 1_000 && now - this.lastIncrease >= 1_000) {
      this.rate++;
      this.lastIncrease = now;
    }
  }

  rateLimited(route: Route) {
    if (!this.current(route)) return;
    const now = this.now();
    this.endProbe(route);
    if (now - this.lastDecrease < 1_000) return;
    this.trim();
    this.rate = Math.max(1, Math.floor(Math.min(this.rate, this.sent.length) / 2));
    this.lastDecrease = now;
    // Waiting tickets have no vested slot: delay() always uses the new rate and actual starts.
  }

  /** A network outage always gets the fixed connectivity retest delay. */
  failed(route: Route) {
    if (!this.current(route)) return;
    this.pause(OUTAGE_PAUSE_MS);
  }

  /** Exhausted credits are unlikely to recover in seconds: back off independently of network failures. */
  quotaExceeded(route: Route) {
    if (!this.current(route)) return;
    this.quotaPauseMs = this.quotaPauseMs === 0 ? QUOTA_PAUSE_MS : Math.min(MAX_QUOTA_PAUSE_MS, this.quotaPauseMs * 2);
    this.pause(this.quotaPauseMs);
  }

  private pause(delayMs: number) {
    this.epoch++;
    this.probing = false;
    this.waiting = [];
    this.downUntil = this.now() + delayMs;
  }

  refused(route: Route) { if (this.current(route)) this.endProbe(route); }

  private current(route: Route): route is PrivateRoute { return route.endpoint === "private" && route.epoch === this.epoch; }
  private endProbe(route: PrivateRoute) {
    // A current success, revert, range or throughput response shows the quota refusal has ended.
    this.quotaPauseMs = 0;
    if (route.probe) { this.probing = false; this.downUntil = 0; }
  }
  private remove(route: PrivateRoute) { this.waiting = this.waiting.filter((r) => r !== route); }
  private trim() { this.sent = this.sent.filter((at) => at > this.now() - 1_000); }

  private delay(target: PrivateRoute): number {
    this.trim();
    const now = this.now();
    const projected = [...this.sent];
    let at = now;
    for (const ticket of this.waiting) {
      if (ticket.deadline < now || ticket.epoch !== this.epoch) continue;
      // Even after a decrease below the already-sent count, wait until enough departures expire.
      const inWindow = projected.filter((t) => t > at - 1_000);
      if (inWindow.length >= this.rate) at = inWindow[inWindow.length - this.rate] + 1_000;
      if (ticket === target) return Math.max(0, at - now);
      if (at <= ticket.deadline) projected.push(at);
    }
    return Infinity;
  }
}
