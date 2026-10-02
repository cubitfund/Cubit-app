export const PUBLIC_CONCURRENCY = 4;
export const PUBLIC_DEADLINE_MS = 10_000;

/** FIFO fallback queue. The deadline includes queueing; a timed-out running job holds its slot until it settles. */
export class RequestPool {
  private active = 0;
  private queue: (() => void)[] = [];
  private limit: number;
  private deadline: number;
  constructor(limit = PUBLIC_CONCURRENCY, deadline = PUBLIC_DEADLINE_MS) {
    this.limit = limit;
    this.deadline = deadline;
  }

  run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        this.queue = this.queue.filter((job) => job !== start);
        controller.abort();
        reject(new Error("Public RPC deadline exceeded (including queue time)."));
      }, this.deadline);
      const start = () => {
        if (expired) return;
        this.active++;
        Promise.resolve().then(() => request(controller.signal)).then(resolve, reject).finally(() => {
          clearTimeout(timer);
          this.active--;
          this.drain();
        });
      };
      this.queue.push(start);
      this.drain();
    });
  }

  private drain() {
    while (this.active < this.limit && this.queue.length) this.queue.shift()!();
  }
}
