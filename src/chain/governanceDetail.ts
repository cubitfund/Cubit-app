import type { Address } from "viem";
import type { GovernanceView } from "./launchpad.ts";
import type { BlockSnapshot } from "./readContext.ts";
import { governanceDetailError, type GovernanceDetails } from "./tranches.ts";

export type GovernanceDetailState = {
  block: BlockSnapshot;
  held: bigint;
  loading: boolean;
  details: GovernanceDetails | null;
  error: string | null;
};
type Loader = (view: GovernanceView, token: Address, held: bigint, page: number | null, signal: AbortSignal) => Promise<GovernanceDetails>;

/** Explicit user requests only. Public block updates never schedule detail reads.
 * Completed results retain their own held/block; they must be displayed as dated observations.
 * One instance belongs to a vault/account UI identity and is cleared after its transactions.
 */
export class GovernanceDetail {
  private values = new Map<string, GovernanceDetailState>();
  private pending = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private load: Loader;
  constructor(load: Loader) { this.load = load; }
  snapshot = () => this.values;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(key: string, state: GovernanceDetailState) {
    this.values = new Map(this.values).set(key, state);
    for (const listener of this.listeners) listener();
  }
  async request(view: GovernanceView, token: Address, page: number | null = null) {
    const asset = view.assets.find((a) => a.token.toLowerCase() === token.toLowerCase());
    if (!asset) return;
    const key = token.toLowerCase();
    this.pending.get(key)?.abort();
    const controller = new AbortController();
    this.pending.set(key, controller);
    const state = { block: { ...view.block }, held: asset.held, details: null, error: null, loading: true };
    this.set(key, state);
    const current = () => !controller.signal.aborted && this.pending.get(key) === controller;
    try {
      const details = await this.load(view, token, asset.held, page, controller.signal);
      if (current()) this.set(key, { ...state, loading: false, details });
    } catch (error) {
      if (current()) this.set(key, { ...state, loading: false, error: governanceDetailError(error) });
    } finally {
      if (this.pending.get(key) === controller) this.pending.delete(key);
    }
  }
  /** Also used on unmount/account change. No transaction callback can restart a disposed read. */
  invalidate() {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.values = new Map();
    for (const listener of this.listeners) listener();
  }
}
