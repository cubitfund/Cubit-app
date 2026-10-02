import { cubitMarket, readMarket, type MarketState } from "./market.ts";
import { assertBlock, type ReadContext } from "./readContext.ts";
import { stringifyData } from "./snapshot.ts";

const figures = (m: MarketState) => ({
  price: [m.sqrtPriceX96, m.tick, m.priceWad, m.priceUnavailable],
  band: m.band, walls: m.walls, wallTotals: [m.wallEth, m.wallCubit],
  pending: [m.pendingFloorEth, m.pendingAbsorbedTokens], nextWall: m.nextWall,
  supply: [m.totalSupply, m.totalBurned, m.lens?.circulatingSupply, m.lens?.heldSupply],
  registry: m.registry, lens: m.lens, vault: m.vault,
});
export async function verifySnapshot(ctx: ReadContext, expected: MarketState) {
  const block = { number: expected.block, hash: expected.blockHash, timestamp: BigInt(expected.timestamp) };
  await assertBlock(ctx, block);
  // The deployment config, not the server's MarketRef, determines the independently verified contracts.
  // readMarket reassembles every Lens page at this hash and derives the supplies from those complete totals.
  const actual = await readMarket(ctx, cubitMarket(ctx.config), block);
  await assertBlock(ctx, block);
  const a = figures(actual), b = figures(expected);
  const differences = (Object.keys(a) as (keyof typeof a)[]).filter((key) => stringifyData(a[key]) !== stringifyData(b[key]));
  return { block: block.number, hash: block.hash, match: differences.length === 0, differences };
}
