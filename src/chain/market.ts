// Reads one market at one block: the CUBIT pool (with its registry, Lens and vault) or a launchpad child (the same hook
// template, without registry, Lens or vault). Walls are read from the hook itself and priced with the Lens's integer
// maths, so the listed walls add up to what the Lens reports.
import { concat, encodeAbiParameters, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { CubitHookAbi, CubitQuoteHookAbi, CubitTokenAbi, CubitV2Abi, CubitVaultAbi } from "./abi.ts";
import { readLens, type LensSnapshot } from "./lens.ts";
import type { ReadContext, BlockSnapshot } from "./readContext.ts";
import { isTickAtLimit, nextWallTick, nextWallTickTokenFirst, positionAmounts, QUOTE_PRICE_SCALE, sqrtPriceAtTick, sqrtPriceToWadPrice, TICK_SPACING, WAD } from "./math.ts";

/** A launchpad v2 child's quote currency: the pool's currency0 (address zero for native ETH). */
export type QuoteInfo = { address: Address; symbol: string; decimals: number };

/** Tax rates in basis points: buys (all to the team), and sales split between the team and the walls. */
export type Taxes = { buyTeamBps: number; sellTeamBps: number; sellWallBps: number };

export type MarketRef = {
  token: Address;
  hook: Address;
  poolId: Hex;
  name: string;
  symbol: string;
  /** First block of this market's history: its launch. */
  fromBlock: bigint;
  /** The CUBIT pool has a registry, a Lens and a vault; launchpad children have none. */
  parent: boolean;
  /** Launchpad v2 children only: their quote currency and the taxes chosen at launch. Absent means native ETH and
   *  CUBIT's taxes (CUBIT itself and launchpad v1 children). */
  quote?: QuoteInfo;
  taxes?: Taxes;
  /** Launchpad v3 children paired with an ERC-20: the token is currency0 and the quote currency1 (TOKEN/QUOTE,
   *  CubitTokenFirstHook). Absent or false: the quote is currency0 (QUOTE/TOKEN). */
  tokenFirst?: boolean;
};

export const POOL_FEE = 100;
const POOLS_SLOT = toHex(6n, { size: 32 });
const WALL_PAGE = 250;

export const extsloadAbi = parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]);

/** The pool key: `quote` is currency0 (native ETH unless a launchpad v2 child pairs with an ERC-20), except for a
 *  token-first child (launchpad v3, ERC-20 pair), whose token is currency0. */
export function poolKeyOf(token: Address, hook: Address, quote: Address = zeroAddress, tokenFirst = false) {
  const [currency0, currency1] = tokenFirst ? [token, quote] : [quote, token];
  return { currency0, currency1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: hook } as const;
}

export function poolIdOf(token: Address, hook: Address, quote: Address = zeroAddress, tokenFirst = false): Hex {
  const key = poolKeyOf(token, hook, quote, tokenFirst);
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, POOL_FEE, TICK_SPACING, hook],
  ));
}

/** The pool key of a market, whatever its quote and orientation. */
export const marketKey = (ref: MarketRef) => poolKeyOf(ref.token, ref.hook, ref.quote?.address ?? zeroAddress, !!ref.tokenFirst);

/** A buy of `ref` (quote in) is zeroForOne unless the token is currency0; a sale the opposite. */
export const zeroForOneOf = (ref: MarketRef, buy: boolean) => buy !== !!ref.tokenFirst;

export const cubitMarket = (config: ReadContext["config"]): MarketRef => ({
  token: config.token, hook: config.hook, poolId: config.poolId, name: "CUBIT", symbol: "CUBIT",
  fromBlock: config.deployBlock, parent: true,
});

export type WallStatus = "active" | "partial" | "crossed";

export type WallState = {
  id: number;
  lower: number;
  liquidity: bigint;
  /** Fresh ETH deployed at this tick since it was created, cumulative. */
  fundedEth: bigint;
  eth: bigint;
  cubit: bigint;
  /** ETH per CUBIT (WAD) at the wall's lower tick: the highest price of its range. */
  priceWad: bigint;
  /** active: pure ETH under the price · partial: the price is inside it · crossed: emptied by a sale. */
  status: WallStatus;
};

export type Registry = {
  vault: Address;
  router: Address;
  lens: Address;
  forge: Address;
  flags: number;
  moduleRevision: bigint;
  vaultCount: bigint;
};

export type { LensSnapshot } from "./lens.ts";

export type VaultTotals = { totalStaked: bigint; rewardReserve: bigint; totalPaid: bigint };

export type MarketState = {
  ref: MarketRef;
  block: bigint;
  blockHash: Hex;
  timestamp: number;
  sqrtPriceX96: bigint;
  tick: number;
  priceWad: bigint;
  /** A sale or a buy swept one side of the book: there is no market price. */
  priceUnavailable: boolean;
  launchSqrtPriceX96: bigint;
  launchPriceWad: bigint;
  band: { lower: number; upper: number; liquidity: bigint; eth: bigint; cubit: bigint };
  walls: WallState[];
  wallEth: bigint;
  wallCubit: bigint;
  activeWalls: number;
  partialWalls: number;
  crossedWalls: number;
  /** Standing wall nearest to the market (lowest tick = highest price), the first a sale meets. */
  nearestWall: WallState | null;
  /** Where the next sale's 12% would go at today's price. */
  nextWall: { lower: number; priceWad: bigint; underMarket: boolean } | null;
  pendingFloorEth: bigint;
  pendingAbsorbedTokens: bigint;
  teamAccrued: bigint;
  teamPaidCumulative: bigint;
  team: Address;
  sink: Address;
  totalSupply: bigint;
  totalBurned: bigint;
  registry: Registry | null;
  lens: LensSnapshot | null;
  vault: VaultTotals | null;
};

export async function readRegistry({ client: publicClient, config: CONFIG }: ReadContext, blockNumber: bigint): Promise<Registry> {
  const at = { address: CONFIG.v2, abi: CubitV2Abi, blockNumber } as const;
  const [vault, router, lens, forge, flags, moduleRevision, vaultCount] = await Promise.all([
    publicClient.readContract({ ...at, functionName: "vault" }),
    publicClient.readContract({ ...at, functionName: "router" }),
    publicClient.readContract({ ...at, functionName: "lens" }),
    publicClient.readContract({ ...at, functionName: "forge" }),
    publicClient.readContract({ ...at, functionName: "enabledFeatures" }),
    publicClient.readContract({ ...at, functionName: "moduleRevision" }),
    publicClient.readContract({ ...at, functionName: "vaultCount" }),
  ]);
  return { vault, router, lens, forge, flags: Number(flags), moduleRevision, vaultCount };
}

export function decodeSlot0(word: Hex): { sqrtPriceX96: bigint; tick: number } {
  const value = BigInt(word);
  const rawTick = Number((value >> 160n) & 0xffffffn);
  return { sqrtPriceX96: value & ((1n << 160n) - 1n), tick: rawTick >= 0x800000 ? rawTick - 0x1000000 : rawTick };
}

export async function readPoolState({ client, config }: ReadContext, ref: MarketRef, blockNumber: bigint) {
  const word = await client.readContract({ address: config.poolManager, abi: extsloadAbi, functionName: "extsload",
    args: [keccak256(concat([ref.poolId, POOLS_SLOT]))], blockNumber });
  return decodeSlot0(word);
}

export class MarketClosedError extends Error {
  constructor(symbol: string) { super(`The ${symbol} market is not open yet.`); this.name = "MarketClosedError"; }
}

async function readWalls({ client: publicClient }: ReadContext, hook: Address, count: number, sqrtPriceX96: bigint, blockNumber: bigint, tokenFirst = false): Promise<WallState[]> {
  const walls: WallState[] = [];
  for (let start = 0; start < count; start += WALL_PAGE) {
    const ids = Array.from({ length: Math.min(WALL_PAGE, count - start) }, (_, i) => start + i);
    const rows = await publicClient.multicall({
      allowFailure: false,
      blockNumber,
      contracts: ids.map((id) => ({ address: hook, abi: CubitHookAbi, functionName: "walls", args: [BigInt(id)] }) as const),
    });
    rows.forEach((row, i) => {
      const [lower, liquidity, , fundedEth] = row as readonly [number, bigint, bigint, bigint];
      const sqrtLower = sqrtPriceAtTick(lower);
      const held = positionAmounts(sqrtPriceX96, lower, lower + TICK_SPACING, liquidity);
      // `eth` is the quote a wall holds and `cubit` its tokens: currency0 and currency1, swapped for a token-first child,
      // whose walls stand UNDER the price (active while the price is at or above their upper tick).
      const [eth, cubit] = tokenFirst ? [held.cubit, held.eth] : [held.eth, held.cubit];
      const entered = tokenFirst ? sqrtPriceX96 < sqrtPriceAtTick(lower + TICK_SPACING) : sqrtPriceX96 > sqrtLower;
      walls.push({
        id: ids[i], lower, liquidity, fundedEth, eth, cubit, priceWad: sqrtPriceToWadPrice(sqrtLower),
        status: liquidity === 0n ? "crossed" : entered ? "partial" : "active",
      });
    });
  }
  return walls;
}

/** Everything one market shows, pinned to the shared clock snapshot. */
export async function readMarket(ctx: ReadContext, ref: MarketRef, block: BlockSnapshot,
  known?: { pool: Awaited<ReturnType<typeof readPoolState>>; registry: Registry },
): Promise<MarketState> {
  const { client: publicClient } = ctx;
  const blockNumber = block.number;
  // A zero slot is a normal prelaunch state. Do not fan out into market getters or the Lens until it opens.
  const { sqrtPriceX96, tick } = known?.pool ?? await readPoolState(ctx, ref, blockNumber);
  if (sqrtPriceX96 === 0n) throw new MarketClosedError(ref.symbol);
  const hook = { address: ref.hook, abi: CubitHookAbi, blockNumber } as const;
  const token = { address: ref.token, abi: CubitTokenAbi, blockNumber } as const;
  const [band, pendingFloorEth, pendingAbsorbedTokens, wallCount, teamAccrued, teamPaidCumulative, launchSqrtPriceX96, team, sink, totalSupply, totalBurned, registry] =
    await Promise.all([
      publicClient.readContract({ ...hook, functionName: "band" }),
      // A launchpad v2 hook names the same book pendingFloorQuote: it holds the quote, not necessarily ETH.
      ref.quote
        ? publicClient.readContract({ address: ref.hook, abi: CubitQuoteHookAbi, functionName: "pendingFloorQuote", blockNumber })
        : publicClient.readContract({ ...hook, functionName: "pendingFloorEth" }),
      publicClient.readContract({ ...hook, functionName: "pendingAbsorbedTokens" }),
      publicClient.readContract({ ...hook, functionName: "wallCount" }),
      publicClient.readContract({ ...hook, functionName: "teamAccrued" }),
      publicClient.readContract({ ...hook, functionName: "teamPaidCumulative" }),
      publicClient.readContract({ ...hook, functionName: "INITIAL_SQRT_PRICE" }),
      publicClient.readContract({ ...hook, functionName: "TEAM_ADDRESS" }),
      publicClient.readContract({ ...hook, functionName: "absorbedTokenSink" }),
      publicClient.readContract({ ...token, functionName: "totalSupply" }),
      publicClient.readContract({ ...token, functionName: "totalBurned" }),
      ref.parent ? (known?.registry ?? readRegistry(ctx, blockNumber)) : Promise.resolve(null),
    ]);

  const [lens, vault, walls] = await Promise.all([
    registry ? readLens(ctx, registry.lens, block) : Promise.resolve(null),
    registry
      ? Promise.all([
          publicClient.readContract({ address: registry.vault, abi: CubitVaultAbi, functionName: "totalStaked", blockNumber }),
          publicClient.readContract({ address: registry.vault, abi: CubitVaultAbi, functionName: "rewardReserve", blockNumber }),
          publicClient.readContract({ address: registry.vault, abi: CubitVaultAbi, functionName: "totalCubitPaid", blockNumber }),
        ]).then(([totalStaked, rewardReserve, totalPaid]) => ({ totalStaked, rewardReserve, totalPaid }))
      : Promise.resolve(null),
    readWalls(ctx, ref.hook, Number(wallCount), sqrtPriceX96, blockNumber, !!ref.tokenFirst),
  ]);
  if (lens && (lens.blockNumber !== blockNumber || lens.tick !== tick)) throw new Error("The Lens answered for another block; retrying.");

  const [bandLower, bandUpper, bandLiquidity] = band;
  const bandHeld = positionAmounts(sqrtPriceX96, bandLower, bandUpper, bandLiquidity);
  const bandAmounts = ref.tokenFirst ? { eth: bandHeld.cubit, cubit: bandHeld.eth } : bandHeld;
  const standing = walls.filter((w) => w.status !== "crossed");
  // The nearest wall is the lowest one above the price, or for a token-first child the highest one under it.
  const nearestWall = standing.reduce<WallState | null>((best, w) =>
    (!best || (ref.tokenFirst ? w.lower > best.lower : w.lower < best.lower) ? w : best), null);
  const next = ref.tokenFirst
    ? nextWallTickTokenFirst(launchSqrtPriceX96, sqrtPriceX96, tick, TICK_SPACING)
    : nextWallTick(launchSqrtPriceX96, sqrtPriceX96, tick, TICK_SPACING, ref.quote ? QUOTE_PRICE_SCALE : WAD);

  return {
    ref,
    block: blockNumber,
    blockHash: block.hash,
    timestamp: Number(block.timestamp),
    sqrtPriceX96,
    tick,
    priceWad: sqrtPriceToWadPrice(sqrtPriceX96),
    priceUnavailable: isTickAtLimit(tick),
    launchSqrtPriceX96,
    launchPriceWad: sqrtPriceToWadPrice(launchSqrtPriceX96),
    band: { lower: bandLower, upper: bandUpper, liquidity: bandLiquidity, eth: bandAmounts.eth, cubit: bandAmounts.cubit },
    walls,
    wallEth: lens ? lens.wallEth : standing.reduce((sum, w) => sum + w.eth, 0n),
    wallCubit: lens ? lens.wallTokens - lens.pendingAbsorbedTokens : standing.reduce((sum, w) => sum + w.cubit, 0n),
    activeWalls: walls.filter((w) => w.status === "active").length,
    partialWalls: walls.filter((w) => w.status === "partial").length,
    crossedWalls: walls.filter((w) => w.status === "crossed").length,
    nearestWall,
    nextWall: next ? { ...next, priceWad: sqrtPriceToWadPrice(sqrtPriceAtTick(next.lower)) } : null,
    pendingFloorEth,
    pendingAbsorbedTokens,
    teamAccrued,
    teamPaidCumulative,
    team,
    sink,
    totalSupply,
    totalBurned,
    registry,
    lens,
    vault,
  };
}
