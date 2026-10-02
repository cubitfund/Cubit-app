import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSeries, type MarketEvent, type MarketHistory, type SwapPoint } from "../src/chain/events.ts";
import { positionAmounts, sqrtPriceAtTick, TICK_SPACING, wadToNumber } from "../src/chain/math.ts";
import { hash } from "./helpers.ts";

const LOWER = 150_000, LIQUIDITY = 10n ** 24n;
const launch = sqrtPriceAtTick(140_000);

const wallFunded = (block: number, addedEth: bigint, liquidity: bigint): MarketEvent => ({
  id: `w${block}`, kind: "WALL_PLACED", block, blockHash: hash(block), logIndex: 0, tx: hash(block),
  wallId: 1, lower: LOWER, ethWei: addedEth, liquidity,
});
const swap = (block: number, tick: number): SwapPoint => ({
  id: `s${block}`, block, blockHash: hash(block), logIndex: 1, tx: hash(block),
  sqrtPriceX96: sqrtPriceAtTick(tick), tick, amount0: 0n, amount1: 0n,
});
const history = (events: MarketEvent[], swaps: SwapPoint[]): MarketHistory =>
  ({ events, swaps, fromBlock: 1n, toBlock: BigInt(100) });

/** Only the fields buildSeries reads; the live tail is checked separately below. */
const market = (extra: Record<string, unknown> = {}) => ({
  ref: { fromBlock: 1n }, launchPriceWad: 10n ** 18n, launchSqrtPriceX96: launch,
  block: 99n, timestamp: 1_200, priceUnavailable: false, priceWad: 10n ** 18n,
  nearestWall: null, wallEth: 0n, ...extra,
} as never);

test("a partly eaten wall counts what it still holds, not what was funded into it", () => {
  // The price enters the wall's range: no event fires, only the price moved.
  const inside = 150_009;
  const funded = positionAmounts(sqrtPriceAtTick(LOWER), LOWER, LOWER + TICK_SPACING, LIQUIDITY).eth;
  const left = positionAmounts(sqrtPriceAtTick(inside), LOWER, LOWER + TICK_SPACING, LIQUIDITY).eth;
  assert.ok(left > 0n && left < funded / 2n, "the vector must leave the wall clearly eaten but not empty");

  const series = buildSeries(history([wallFunded(10, funded, LIQUIDITY)], [swap(11, inside)]), market());
  const eaten = series.find((p) => p.block === 11)!;
  assert.equal(eaten.ethInWalls, wadToNumber(left));
  assert.notEqual(eaten.ethInWalls, wadToNumber(funded));
});

test("a wall thickened twice takes the event's total liquidity, never the sum of the deltas", () => {
  // WallFunded carries the wall's liquidity AFTER funding: accumulating it would double-count.
  const above = 149_000; // price above the wall: the position is pure ETH
  const series = buildSeries(
    history([wallFunded(10, 1n, LIQUIDITY), wallFunded(12, 1n, LIQUIDITY * 2n)], [swap(13, above)]),
    market(),
  );
  const expected = positionAmounts(sqrtPriceAtTick(above), LOWER, LOWER + TICK_SPACING, LIQUIDITY * 2n).eth;
  assert.equal(series.find((p) => p.block === 13)!.ethInWalls, wadToNumber(expected));
});

test("a fully crossed wall drops to zero, and the live tail keeps the Lens figure", () => {
  const absorbed: MarketEvent = {
    id: "a", kind: "ABSORPTION", block: 14, blockHash: hash(14), logIndex: 0, tx: hash(14), wallId: 1, cubit: 5n, ethWei: 0n,
  };
  const series = buildSeries(
    history([wallFunded(10, 7n, LIQUIDITY), absorbed], [swap(11, 149_000)]),
    market({ wallEth: 42n * 10n ** 18n }),
  );
  assert.equal(series.find((p) => p.block === 14)!.ethInWalls, 0);
  assert.equal(series.at(-1)!.ethInWalls, 42, "the last point stays the exact Lens total");
});
