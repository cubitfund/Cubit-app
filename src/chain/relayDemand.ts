/** Mounted consumers, not URL guesses: nested or future swap panels share one session widget. */
export class RelayDemand {
  private consumers = new Set<symbol>();
  private listeners = new Set<() => void>();
  getSnapshot = () => this.consumers.size > 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  acquire = () => {
    const consumer = Symbol();
    const wasActive = this.getSnapshot();
    this.consumers.add(consumer);
    if (!wasActive) for (const listener of this.listeners) listener();
    return () => {
      if (this.consumers.delete(consumer) && !this.getSnapshot()) for (const listener of this.listeners) listener();
    };
  };
}
export const relayDemand = new RelayDemand();
