// A market's history from its logs: the hook's events (taxes, walls placed and crossed, deliveries) and the
// PoolManager's Swap events for its pool. Pure functions over the read client: the store and the pages share them.
import { parseAbiItem, type Address, type Hex } from "viem";
import { CubitHookAbi } from "./abi.ts";
import type { ReadContext, BlockSnapshot } from "./readContext.ts";
import { chunked, createLogCursor, replaceWindow, type CursorPersistence } from "./logCursor.ts";
export { chunked } from "./logCursor.ts";
import { isTickAtLimit, positionAmounts, sqrtPriceAtTick, sqrtPriceToWadPrice, TICK_SPACING, wadToNumber } from "./math.ts";
import type { MarketRef, MarketState } from "./market.ts";

export type EventKind = "BUY" | "SELL" | "WALL_PLACED" | "ABSORPTION" | "DELIVERED" | "BAND" | "TEAM";

export type MarketEvent = {
  id: string;
  kind: EventKind;
  block: number;
  blockHash: Hex;
  logIndex: number;
  tx: Hex;
  ethWei?: bigint;
  toWallsWei?: bigint;
  toTeamWei?: bigint;
  wallId?: number;
  lower?: number;
  liquidity?: bigint;
  cubit?: bigint;
  sink?: Address;
};

export type SwapPoint = { id: string; block: number; blockHash: Hex; logIndex: number; tx: Hex; sqrtPriceX96: bigint; tick: number; amount0: bigint; amount1: bigint };

export type MarketHistory = { events: MarketEvent[]; swaps: SwapPoint[]; fromBlock: bigint; toBlock: bigint };

export const emptyHistory = (toBlock = 0n): MarketHistory => ({ events: [], swaps: [], fromBlock: toBlock + 1n, toBlock });

const HOOK_EVENTS = CubitHookAbi.filter((item) => item.type === "event");
const SWAP_EVENT = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

type LogArgs = Record<string, unknown>;
const order = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) => a.block - b.block || a.logIndex - b.logIndex;

/** Logs in [fromBlock, toBlock], decoded, in chain order. */
export async function fetchHistory({ client: publicClient, config: CONFIG }: ReadContext, ref: MarketRef, fromBlock: bigint, toBlock: bigint): Promise<MarketHistory> {
  if (toBlock < fromBlock) return emptyHistory(toBlock);
  const [hookLogs, swapLogs] = await Promise.all([
    chunked(fromBlock, toBlock, (from, to) => publicClient.getLogs({ address: ref.hook, events: HOOK_EVENTS, fromBlock: from, toBlock: to })),
    chunked(fromBlock, toBlock, (from, to) => publicClient.getLogs({ address: CONFIG.poolManager, event: SWAP_EVENT, args: { id: ref.poolId }, fromBlock: from, toBlock: to })),
  ]);
  const events: MarketEvent[] = [];
  for (const log of hookLogs) {
    const args = (log as unknown as { args: LogArgs }).args;
    const name = (log as unknown as { eventName: string }).eventName;
    const base = { id: `${log.transactionHash}-${log.logIndex}`, block: Number(log.blockNumber), blockHash: log.blockHash as Hex, logIndex: log.logIndex ?? 0, tx: log.transactionHash as Hex };
    switch (name) {
      case "BuyTaxed":
        events.push({ ...base, kind: "BUY", ethWei: args.ethIn as bigint, toTeamWei: args.toTeam as bigint });
        break;
      case "SellTaxed":
        events.push({ ...base, kind: "SELL", ethWei: args.ethOut as bigint, toWallsWei: args.toFloor as bigint, toTeamWei: args.toTeam as bigint });
        break;
      case "WallFunded":
        events.push({ ...base, kind: "WALL_PLACED", wallId: Number(args.id), lower: Number(args.lower), ethWei: args.addedEth as bigint, liquidity: args.liquidity as bigint });
        break;
      case "WallAbsorbed":
        events.push({ ...base, kind: "ABSORPTION", wallId: Number(args.id), cubit: args.cubit as bigint, ethWei: args.ethRemaining as bigint });
        break;
      case "AbsorbedDelivered":
        events.push({ ...base, kind: "DELIVERED", sink: args.sink as Address, cubit: args.amount as bigint });
        break;
      case "TeamPaid":
        events.push({ ...base, kind: "TEAM", ethWei: args.amount as bigint });
        break;
      case "BandBootstrapped":
        events.push({ ...base, kind: "BAND", lower: Number(args.lower), liquidity: args.liquidity as bigint, cubit: args.tokens as bigint });
        break;
      default:
        break;
    }
  }
  const swaps: SwapPoint[] = swapLogs.map((log) => ({
    id: `${log.transactionHash}-${log.logIndex}`,
    block: Number(log.blockNumber),
    blockHash: log.blockHash as Hex,
    logIndex: log.logIndex ?? 0,
    tx: log.transactionHash as Hex,
    sqrtPriceX96: log.args.sqrtPriceX96 as bigint,
    tick: Number(log.args.tick),
    amount0: log.args.amount0 as bigint,
    amount1: log.args.amount1 as bigint,
  }));
  return { events: events.sort(order), swaps: swaps.sort(order), fromBlock, toBlock };
}

/** Replace every event in the reread window: orphaned logs must disappear even when the new range is empty. */
export function mergeHistory(older: MarketHistory, newer: MarketHistory): MarketHistory {
  return {
    events: replaceWindow(older.events, newer.events, newer.fromBlock, newer.toBlock).sort(order),
    swaps: replaceWindow(older.swaps, newer.swaps, newer.fromBlock, newer.toBlock).sort(order),
    fromBlock: older.fromBlock < newer.fromBlock ? older.fromBlock : newer.fromBlock,
    toBlock: newer.toBlock,
  };
}

export function createHistoryReader(ctx: ReadContext, ref: MarketRef, persistence?: CursorPersistence) {
  type Row = (MarketEvent & { rowType: "event" }) | (SwapPoint & { rowType: "swap" });
  const cursor = createLogCursor<Row>(ref.fromBlock, async (from, to) => {
    const history = await fetchHistory(ctx, ref, from, to);
    return [...history.events.map((e) => ({ ...e, rowType: "event" as const })), ...history.swaps.map((s) => ({ ...s, rowType: "swap" as const }))];
  }, async (number) => (await ctx.client.getBlock({ blockNumber: number })).hash, persistence);
  return async (block: BlockSnapshot): Promise<MarketHistory> => {
    const rows = await cursor.read(block);
    return {
      events: rows.filter((r): r is MarketEvent & { rowType: "event" } => r.rowType === "event").sort(order),
      swaps: rows.filter((r): r is SwapPoint & { rowType: "swap" } => r.rowType === "swap").sort(order),
      fromBlock: ref.fromBlock, toBlock: block.number,
    };
  };
}

/** Block number alone is not an identity. A changed hash evicts the old timestamp before it can be reused. */
export function createBlockTimes() {
  const timestamps = new Map<number, { hash: Hex; time: number }>();
  return async (ctx: ReadContext, blocks: { block: number; blockHash: Hex }[]): Promise<Map<number, number>> => {
    const wanted = new Map(blocks.map((b) => [b.block, b.blockHash]));
    const missing = [...wanted].filter(([b, hash]) => {
      if (timestamps.get(b)?.hash === hash) return false;
      timestamps.delete(b);
      return true;
    });
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(missing.slice(i, i + 8).map(async ([number, hash]) => {
        const value = await ctx.client.getBlock({ blockNumber: BigInt(number) });
        if (value.hash !== hash) throw new Error("Event block changed while reading its timestamp.");
        timestamps.set(number, { hash, time: Number(value.timestamp) * 1_000 });
      }));
    }
    return new Map([...wanted.keys()].map((number) => [number, timestamps.get(number)!.time]));
  };
}

export type SeriesPoint = {
  t: number;
  block: number;
  ts?: number;
  marketPriceETH: number | null;
  /** Highest-priced standing wall, 0 when none stands. */
  topWallLevel: number;
  /** ETH the standing walls still hold at this point's price, partial fills included. */
  ethInWalls: number;
};

/** Replays swaps and wall events in chain order into a price / wall-support series, ending on the live state. */
export function buildSeries(history: MarketHistory, state: MarketState | null, limit = 600): SeriesPoint[] {
  // A wall keeps its liquidity until it is fully crossed, and a partial fill emits no event. Summing what was
  // funded would therefore count an already half-eaten wall in full. Its remaining ETH is recomputed from that
  // liquidity at each point's price instead, exactly as readWalls does for the live state.
  const walls = new Map<number, { price: number; lower: number; liquidity: bigint; standing: boolean }>();
  let price: number | null = state ? wadToNumber(state.launchPriceWad) : null;
  let sqrtPriceX96: bigint | null = state ? state.launchSqrtPriceX96 : null;
  const points: SeriesPoint[] = [];
  const push = (block: number) => {
    let top = 0;
    let eth = 0n;
    for (const w of walls.values()) {
      if (!w.standing) continue;
      if (w.price > top) top = w.price;
      if (sqrtPriceX96 !== null) eth += positionAmounts(sqrtPriceX96, w.lower, w.lower + TICK_SPACING, w.liquidity).eth;
    }
    points.push({ t: points.length, block, marketPriceETH: price, topWallLevel: top, ethInWalls: wadToNumber(eth) });
  };
  const items = [
    ...history.swaps.map((s) => ({ block: s.block, logIndex: s.logIndex, swap: s, event: null as MarketEvent | null })),
    ...history.events.filter((e) => e.kind === "WALL_PLACED" || e.kind === "ABSORPTION").map((e) => ({ block: e.block, logIndex: e.logIndex, swap: null as SwapPoint | null, event: e })),
  ].sort(order);
  if (state) push(Number(state.ref.fromBlock));
  for (const item of items) {
    if (item.swap) {
      price = isTickAtLimit(item.swap.tick) ? null : wadToNumber(sqrtPriceToWadPrice(item.swap.sqrtPriceX96));
      sqrtPriceX96 = item.swap.sqrtPriceX96;
    } else if (item.event?.kind === "WALL_PLACED" && item.event.wallId !== undefined && item.event.lower !== undefined) {
      const known = walls.get(item.event.wallId);
      walls.set(item.event.wallId, {
        price: known?.price ?? wadToNumber(sqrtPriceToWadPrice(sqrtPriceAtTick(item.event.lower))),
        lower: item.event.lower,
        // WallFunded carries the wall's liquidity AFTER funding, not the delta: replace it, never accumulate.
        liquidity: item.event.liquidity ?? known?.liquidity ?? 0n,
        standing: true,
      });
    } else if (item.event?.kind === "ABSORPTION" && item.event.wallId !== undefined) {
      const known = walls.get(item.event.wallId);
      if (known) walls.set(item.event.wallId, { ...known, liquidity: 0n, standing: false });
    }
    push(item.block);
  }
  if (state) {
    points.push({
      t: points.length,
      block: Number(state.block),
      ts: state.timestamp * 1000,
      marketPriceETH: state.priceUnavailable ? null : wadToNumber(state.priceWad),
      topWallLevel: state.nearestWall ? wadToNumber(state.nearestWall.priceWad) : 0,
      ethInWalls: wadToNumber(state.wallEth),
    });
  }
  const sliced = points.slice(-limit);
  return sliced.map((p, t) => ({ ...p, t }));
}
