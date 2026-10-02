import type { BlockSnapshot } from "./readContext.ts";
import { MarketClosedError, type MarketState, type Registry } from "./market.ts";
import { mergeHistory, type MarketHistory } from "./events.ts";
import { keccak256, stringToHex } from "viem";
import type { ChildLaunch, ForgeView, GovernanceView } from "./launchpad.ts";
import type { VaultView } from "./vault.ts";
import type { ChildLaunchV2, ForgeV2View } from "./launchpadV2.ts";
import { DEPLOYMENT } from "./deployment.ts";

export const SCHEMA_VERSION = 4;
export const DATA_PATH = "/data/mainnet";
export const MARKET_CLOSED_CODE = "MARKET_CLOSED";
export const SNAPSHOT_STALE_MS = 60_000;
export const SNAPSHOT_BLOCK_STALE_MS = 300_000;
export const SNAPSHOT_WARNING_MS = 300_000;
export type HistoryPart = { from: bigint; to: bigint; path: string };
export type SnapshotHistory = { parts: HistoryPart[]; recent: MarketHistory };
export type DataSnapshot = {
  schemaVersion: typeof SCHEMA_VERSION; chainId: number; block: BlockSnapshot; producedAt: number;
  market: MarketState; registry: Registry; vaults: VaultView[];
  forge: ForgeView | null; children: ChildLaunch[];
  /** Launchpad v2 (optional: a snapshot from before it, or a build without it, has neither). Its children's markets
   *  are in `markets` like the first launchpad's; their histories are not shared. */
  forgeV2?: ForgeV2View | null; childrenV2?: ChildLaunchV2[];
  markets: Record<string, { market: MarketState | null; error: string | null }>;
  governance: GovernanceView | null;
  histories: Record<string, SnapshotHistory>;
  eventTimes: Record<string, number>;
};

/** Lossless, explicit bigint encoding shared by HTTP and storage. */
export const stringifyData = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? { $bigint: String(v) } : v);
export function parseData<T>(text: string): T {
  return JSON.parse(text, (_, v) => v && typeof v === "object" && Object.keys(v).length === 1 &&
    typeof v.$bigint === "string" && /^-?\d{1,78}$/.test(v.$bigint) ? BigInt(v.$bigint) : v) as T;
}
export function parseSnapshot(text: string, chainId = DEPLOYMENT.chainId): DataSnapshot {
  const s = parseData<DataSnapshot>(text);
  if (!s || s.schemaVersion !== SCHEMA_VERSION || s.chainId !== chainId || typeof s.block?.number !== "bigint" ||
      typeof s.block.timestamp !== "bigint" || !/^0x[\da-f]{64}$/i.test(s.block.hash) ||
      !Number.isFinite(s.producedAt) || !s.market || !s.registry || !Array.isArray(s.children) || !s.histories || !s.eventTimes ||
      !Array.isArray(s.vaults) || !s.markets || typeof s.markets !== "object" ||
      !("forge" in s) || !("governance" in s) ||
      s.market.blockHash !== s.block.hash || s.market.block !== s.block.number ||
      s.vaults.some((v) => !v || v.block?.hash !== s.block.hash || v.block.number !== s.block.number ||
        v.block.timestamp !== s.block.timestamp || v.chainTime !== s.block.timestamp || v.position !== null))
    throw new Error("Unsupported or invalid data snapshot.");
  return s;
}
export const snapshotStale = (s: DataSnapshot, now = Date.now()) =>
  now - s.producedAt > SNAPSHOT_STALE_MS || now - Number(s.block.timestamp) * 1_000 > SNAPSHOT_BLOCK_STALE_MS;

/** HTTP data cache, with snapshots retained by hash while page reads finish. No browser/React dependency. */
export class SnapshotClient {
  current: DataSnapshot | null = null;
  error: string | null = null;
  private base: string;
  private fetch: typeof fetch;
  private pending: Promise<DataSnapshot> | null = null;
  private snapshots = new Map<string, DataSnapshot>();
  private ranges = new Map<string, Promise<MarketHistory>>();
  private listeners = new Set<() => void>();
  private chainId: number;
  private path: string;
  // `fetch` must keep its global receiver: calling it as a method throws "Illegal invocation" in a browser.
  constructor(base: string, request: typeof fetch = fetch, { chainId = DEPLOYMENT.chainId, path = DATA_PATH } = {}) {
    this.base = base; this.fetch = request.bind(globalThis); this.chainId = chainId; this.path = path;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  refresh(): Promise<DataSnapshot> {
    if (this.pending) return this.pending;
    this.pending = this.text(`${this.path}/latest.json`).then((text) => {
      const s = parseSnapshot(text, this.chainId);
      this.current = s; this.error = null; this.snapshots.set(s.block.hash, s);
      while (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
      return s;
    }).catch((e) => {
      if (e instanceof MarketClosedError) { this.error = null; throw e; }
      this.error = "Shared data unavailable. Last snapshot retained."; throw new Error(this.error);
    })
      .finally(() => { this.pending = null; for (const listener of this.listeners) listener(); });
    return this.pending;
  }
  at(block: BlockSnapshot) {
    const s = this.snapshots.get(block.hash);
    if (!s || s.block.number !== block.number) throw new Error("Snapshot changed; refresh the page data.");
    return s;
  }
  async history(token: string, block: BlockSnapshot, snapshot = this.at(block)): Promise<MarketHistory> {
    const h = snapshot.histories[token.toLowerCase()];
    if (!h) throw new Error("Market history unavailable.");
    let result: MarketHistory = { events: [], swaps: [], fromBlock: h.parts[0]?.from ?? h.recent.fromBlock, toBlock: 0n };
    // Frozen ranges are fetched only by pages showing history. The replacement tail removes orphaned rows.
    for (const part of h.parts) {
      const prefix = `${this.path}/history/${token.toLowerCase()}/`;
      if (!part.path.startsWith(prefix) || !/^\d+-\d+\/0x[\da-f]{64}\.json$/.test(part.path.slice(prefix.length))) throw new Error("Invalid history path.");
      let pending = this.ranges.get(part.path);
      if (!pending) {
        pending = this.text(part.path).then((text) => {
          if (!part.path.endsWith(`/${keccak256(stringToHex(text))}.json`)) throw new Error("History content hash mismatch.");
          const value = parseData<MarketHistory>(text);
          if (value.fromBlock !== part.from || value.toBlock !== part.to) throw new Error("History range mismatch.");
          return value;
        }).catch((e) => { this.ranges.delete(part.path); throw e; });
        this.ranges.set(part.path, pending);
      }
      result = mergeHistory(result, await pending);
    }
    return mergeHistory(result, h.recent);
  }
  private async text(path: string) {
    const response = await this.fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      // Only the latest publication can report an expected prelaunch state; history failures remain failures.
      if (path === `${this.path}/latest.json` && response.status === 503) {
        const error = await response.json() as { code?: unknown } | null;
        if (error?.code === MARKET_CLOSED_CODE) throw new MarketClosedError("CUBIT");
      }
      throw new Error("Data request failed.");
    }
    return response.text();
  }
}
