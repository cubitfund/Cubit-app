import { cubitMarket, MarketClosedError, readMarket, readPoolState, readRegistry, type MarketRef, type MarketState, type Registry } from "./market.ts";
import { readLens } from "./lens.ts";
import { createHistoryReader } from "./events.ts";
import { createLaunchpadReader, readForge, readGovernance } from "./launchpad.ts";
import { createLaunchpadV2Reader, readForgeV2, type V2Context } from "./launchpadV2.ts";
import { readVault, readVaultAddresses } from "./vault.ts";
import { assertBlock, type ReadContext, type BlockSnapshot } from "./readContext.ts";
import { SNAPSHOT_WARNING_MS, snapshotStale, type DataSnapshot, type SnapshotClient } from "./snapshot.ts";
import type { ClockBlock } from "./blockClock.ts";
import type { Address, Hex } from "viem";

export type ProtocolView = { marketOpen: boolean; market: MarketState | null; registry: Registry; wallEth: bigint };

/** Select one source per clock sample, retaining that choice while its page reads finish.
 * The direct context is public-only when a Worker is configured; visitor reads keep their relay.
 * No timer here: the shared block clock controls probes, visibility and each consumer's cadence. */
export class PublicData {
  warning: string | null = null;
  private degradedSince: number | null = null;
  private selected = new WeakMap<BlockSnapshot, DataSnapshot>();
  private listeners = new Set<() => void>();
  private directChildren: ReturnType<typeof createLaunchpadReader>;
  private directChildrenV2: ReturnType<typeof createLaunchpadV2Reader>;
  private direct: ReadContext;
  private visitor: ReadContext;
  private snapshots: SnapshotClient | null;
  private now: () => number;

  constructor(direct: ReadContext, visitor: ReadContext, snapshots: SnapshotClient | null, now = Date.now) {
    this.direct = direct; this.visitor = visitor; this.snapshots = snapshots; this.now = now;
    this.directChildren = createLaunchpadReader(direct);
    this.directChildrenV2 = createLaunchpadV2Reader(direct as unknown as V2Context);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private warn(warning: string | null) {
    if (warning === null) this.degradedSince = null;
    else {
      const now = this.now();
      // Keep the first failure across retries and cause changes until a fresh snapshot or closed-market response.
      this.degradedSince ??= now;
      if (now - this.degradedSince <= SNAPSHOT_WARNING_MS) return;
    }
    this.warning = warning;
    for (const listener of this.listeners) listener();
  }

  readHead = async (): Promise<ClockBlock> => {
    if (this.snapshots) {
      try {
        const s = await this.snapshots.refresh();
        if (!snapshotStale(s, this.now())) {
          const block: ClockBlock = { ...s.block, source: "shared" };
          this.selected.set(block, s);
          this.warn(null);
          return block;
        }
        this.warn("Shared snapshot is stale. Using the public RPC for live data.");
      } catch (e) {
        this.warn(e instanceof MarketClosedError ? null : "Shared data unavailable. Using the public RPC for live data.");
      }
    }
    const block = await this.direct.client.getBlock({ blockTag: "latest" });
    return { number: block.number, hash: block.hash, timestamp: block.timestamp, source: "direct" };
  };

  snapshot(block: BlockSnapshot) { return this.selected.get(block) ?? null; }
  context(block: BlockSnapshot) { return this.snapshot(block) ? this.visitor : this.direct; }
  fresh(block: BlockSnapshot, now = this.now()) {
    const s = this.snapshot(block);
    return !s || !snapshotStale(s, now);
  }
  assertBlock = async (block: BlockSnapshot) => {
    // A shared snapshot was canonical when produced, but may have been orphaned before page reads finish.
    // Use the independent public RPC, including after visitor reads succeeded through the relay's cache.
    await assertBlock(this.direct, block);
  };
  children = (block: BlockSnapshot) => {
    const s = this.snapshot(block);
    return s ? Promise.resolve(s.children) : this.directChildren(block);
  };
  /** Launchpad v2: from the shared snapshot when it carries them, else read directly. */
  childrenV2 = (block: BlockSnapshot) => {
    const s = this.snapshot(block);
    return s?.childrenV2 ? Promise.resolve(s.childrenV2) : this.directChildrenV2(block);
  };
  forgeV2 = (block: BlockSnapshot) => {
    const s = this.snapshot(block);
    return s?.forgeV2 ? Promise.resolve(s.forgeV2) : readForgeV2(this.direct as unknown as V2Context, block);
  };
  async protocol(block: BlockSnapshot, full: boolean): Promise<ProtocolView> {
    const s = this.snapshot(block);
    if (s) return { marketOpen: true, market: full ? s.market : null, registry: s.registry, wallEth: s.market.wallEth };
    const ref = cubitMarket(this.direct.config);
    const [pool, registry] = await Promise.all([
      readPoolState(this.direct, ref, block.number), readRegistry(this.direct, block.number),
    ]);
    if (pool.sqrtPriceX96 === 0n) return { marketOpen: false, market: null, registry, wallEth: 0n };
    if (!full) {
      const lens = await readLens(this.direct, registry.lens, block);
      return { marketOpen: true, market: null, registry, wallEth: lens.wallEth };
    }
    const market = await readMarket(this.direct, ref, block, { pool, registry });
    return { marketOpen: true, market, registry, wallEth: market.wallEth };
  }
  async market(ref: MarketRef, block: BlockSnapshot) {
    const s = this.snapshot(block);
    if (!s) return readMarket(this.direct, ref, block);
    if (ref.parent) return s.market;
    const entry = s.markets[ref.token.toLowerCase()];
    // A launchpad v2 child in a snapshot that does not carry the launchpad v2 (a worker from before it): read it directly.
    if (!entry && ref.quote && !s.childrenV2) return readMarket(this.direct, ref, block);
    if (!entry?.market) throw new Error(entry?.error ?? "Market unavailable in this snapshot.");
    return entry.market;
  }
  history(ref: MarketRef) {
    // Keep the direct cursor across source changes; returning to it rereads only its missing tail.
    const direct = createHistoryReader(this.direct, ref);
    return async (block: BlockSnapshot) => {
      const s = this.snapshot(block);
      if (s) {
        try { return await this.snapshots!.history(ref.token, block, s); }
        catch { this.warn("Shared history unavailable. Using the public RPC for history."); }
      }
      return direct(block);
    };
  }
  async forge(forge: Address, block: BlockSnapshot) {
    const s = this.snapshot(block);
    if (!s) return readForge(this.direct, forge, block);
    const f = s.forge;
    if (!f || f.forge.toLowerCase() !== forge.toLowerCase()) throw new Error("Forge changed; waiting for the next snapshot.");
    return f;
  }
  async governance(vault: Address, tokens: { token: Address; symbol: string }[], block: BlockSnapshot, account: Address | null, pages: Record<string, number>) {
    const s = this.snapshot(block), shared = s?.governance;
    if (s && (!shared || shared.vault.toLowerCase() !== vault.toLowerCase())) throw new Error("Governance vault changed.");
    return readGovernance(this.context(block), vault, tokens, block, account, pages, shared ?? undefined);
  }
  async vault(vault: Address, current: boolean, account: Address | null, block: BlockSnapshot) {
    const s = this.snapshot(block), shared = s?.vaults.find((v) => v.vault.toLowerCase() === vault.toLowerCase());
    if (s && !shared) throw new Error("Vault unavailable in this snapshot.");
    return readVault(this.context(block), vault, current, account, block, shared);
  }
  /** One vault read at a given block through the direct RPC, never the shared snapshot: right after the account's own
   *  transaction its position must show that block, and the snapshot can be ~30 s older. */
  async vaultAt(vault: Address, current: boolean, account: Address | null, at: { blockHash: Hex }) {
    const b = await this.direct.client.getBlock({ blockHash: at.blockHash });
    return readVault(this.direct, vault, current, account, { number: b.number, hash: b.hash, timestamp: b.timestamp });
  }
  vaultAddresses = (block: BlockSnapshot) => {
    const s = this.snapshot(block);
    return s ? Promise.resolve(s.vaults.map((v) => v.vault)) : readVaultAddresses(this.direct, block);
  };
}
