// Pure BigInt/number conversions between the contracts' units and the UI's numbers, and exact ports of the
// v4-core / BandLib maths the app needs to price walls and predict the next wall. No React here.
// Contract prices are ETH per CUBIT in 1e18 fixed point; the pool orientation is CUBIT per ETH (ETH is currency0).

export const WAD = 10n ** 18n;
/** QuoteBandLib.PRICE_SCALE: a launchpad v2 child's prices. */
export const QUOTE_PRICE_SCALE = 10n ** 36n;
export const Q96 = 2n ** 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
export const TICK_SPACING = 10;
/** BandLib.WALL_RETRACEMENT_BPS: a wall targets 40% of the price at the sale + 60% of the launch price. */
export const WALL_RETRACEMENT_BPS = 6000n;
/** BandLib.WALL_UNDER_MARKET_BPS: at or below launch the wall goes 1% under the price. */
export const WALL_UNDER_MARKET_BPS = 100n;

/** 1e18-fixed value -> JS number (sub-micro prices keep ~15 significant digits). */
export const wadToNumber = (x: bigint): number => Number(x) / 1e18;
export const weiToEth = wadToNumber;
export const tokensToNumber = wadToNumber;

/**
 * A user-typed decimal string -> 1e18 base units, exactly: every digit up to 18 decimals is kept and the rest is
 * truncated, never rounded up (selling "exactly my balance" must not ask for one more wei). Anything that is not a
 * plain non-negative decimal returns 0n.
 */
export function parseAmount(input: string): bigint {
  const s = input.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole || "0") * WAD + BigInt((frac + "0".repeat(18)).slice(0, 18) || "0");
}

/** 1e18 base units -> a plain decimal string with at most `decimals` decimals, truncated. */
export function formatUnits18(value: bigint, decimals = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / WAD;
  const frac = (abs % WAD).toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** A user-typed decimal string -> base units of a token with `decimals` decimals, truncated like parseAmount. */
export function parseUnitsDec(input: string, decimals: number): bigint {
  const s = input.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [whole, frac = ""] = s.split(".");
  const unit = 10n ** BigInt(decimals);
  return BigInt(whole || "0") * unit + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Base units of a token with `decimals` decimals -> a plain decimal string with at most `shown` decimals, truncated. */
export function formatUnitsDec(value: bigint, decimals: number, shown = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const frac = (abs % unit).toString().padStart(decimals, "0").slice(0, shown).replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / unit}${frac ? `.${frac}` : ""}`;
}

/** Base units -> JS number, for display only. */
export const unitsToNumber = (value: bigint, decimals: number): number => Number(value) / 10 ** decimals;

/** The token's price in human quote units per token (18-decimal token, quote with `quoteDecimals`), for display:
 *  (2^96 / sqrtP)^2 quote base units per token base unit, times 10^(18 - quoteDecimals). */
export function sqrtPriceToQuotePrice(sqrtPriceX96: bigint, quoteDecimals: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  const ratio = Number(Q96) / Number(sqrtPriceX96);
  return ratio * ratio * 10 ** (18 - quoteDecimals);
}

/** Slippage in percent with at most two decimals, in [0, 100). */
export function parseSlippage(input: string): number | null {
  if (!/^\d*(?:\.\d{0,2})?$/.test(input) || !/\d/.test(input)) return null;
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 && value < 100 ? value : null;
}

/** Minimum output for a quote and a slippage tolerance, rounded up by at most one unit and never zero. */
export function minOut(quote: bigint, slippagePct: number): bigint {
  if (quote <= 0n || !Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct >= 100) {
    throw new Error("A positive quote and a slippage between 0 and 99.99% are required.");
  }
  const bps = BigInt(Math.round(slippagePct * 100));
  return (quote * (10_000n - bps) + 9_999n) / 10_000n;
}

const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;

/** BandLib.ethPerCubitAtSqrt: ETH per CUBIT (WAD) at a pool sqrtPriceX96, 1e18 * 2^192 / sqrtP^2 in two steps. */
export function sqrtPriceToWadPrice(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  return mulDiv(mulDiv(WAD, Q96, sqrtPriceX96), Q96, sqrtPriceX96);
}

/** The pool tick at a limit: a trade swept one side of the book, there is no real price. */
export function isTickAtLimit(tick: number): boolean {
  return tick <= MIN_TICK || tick >= MAX_TICK - 1;
}

const MAX_UINT256 = (1n << 256n) - 1n;
// TickMath: 1/sqrt(1.0001^(2^i)) in Q128.128 for every bit i >= 1 of |tick|.
const TICK_FACTORS: readonly (readonly [bigint, bigint])[] = [
  [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

/** v4-core TickMath.getSqrtPriceAtTick, bit for bit. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("Invalid tick.");
  const absTick = BigInt(Math.abs(tick));
  let price = (absTick & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of TICK_FACTORS) if ((absTick & bit) !== 0n) price = (price * factor) >> 128n;
  if (tick > 0) price = MAX_UINT256 / price;
  return (price + 0xffffffffn) >> 32n;
}

/** v4-core TickMath.getTickAtSqrtPrice: the greatest tick whose sqrt price is <= sqrtPriceX96 (exact, by bisection). */
export function tickAtSqrtPrice(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) throw new Error("Invalid sqrt price.");
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (sqrtPriceAtTick(mid) <= sqrtPriceX96) low = mid;
    else high = mid - 1;
  }
  return low;
}

export const ethPerCubitAtTick = (tick: number): bigint => sqrtPriceToWadPrice(sqrtPriceAtTick(tick));

export function floorToSpacing(tick: number, spacing = TICK_SPACING): number {
  let c = Math.trunc(tick / spacing);
  if (tick < 0 && tick % spacing !== 0) c--;
  return c * spacing;
}

export function ceilToSpacing(tick: number, spacing = TICK_SPACING): number {
  const f = floorToSpacing(tick, spacing);
  return f === tick ? f : f + spacing;
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** BandLib.sqrtPriceForRatio: pool sqrtPriceX96 (CUBIT per ETH) for a price of ethE ETH per supplyC CUBIT. */
export function sqrtPriceForRatio(ethE: bigint, supplyC: bigint): bigint {
  if (ethE === 0n) return MAX_UINT256;
  return isqrt((supplyC << 128n) / ethE) << 32n;
}

/** BandLib.wallTarget: the lower tick of a one-spacing wall that executes at prices <= ethE/supplyC. */
export function wallTarget(ethE: bigint, supplyC: bigint, spotTick: number, spacing = TICK_SPACING): number {
  const maxLower = Math.floor(MAX_TICK / spacing) * spacing - spacing;
  const cap = ceilToSpacing(spotTick + 1, spacing);
  const sqrtX96 = sqrtPriceForRatio(ethE, supplyC);
  const t = sqrtX96 >= MAX_SQRT_PRICE ? MAX_TICK : sqrtX96 < MIN_SQRT_PRICE ? MIN_TICK : tickAtSqrtPrice(sqrtX96);
  let lower = ceilToSpacing(t + 1, spacing);
  if (lower < cap) lower = cap;
  if (lower > maxLower) lower = maxLower;
  return lower;
}

/**
 * CubitHook._placeWall, as a prediction at the current price: the tick the next sale's 12% goes to. The 40/60 target
 * first; at or below launch that target is not under the market, so 1% under the price; null when no position fits
 * under the price (the funds would wait). The sale itself moves the price first: this is the target at today's price.
 */
export function nextWallTick(
  launchSqrtPriceX96: bigint, sqrtPriceX96: bigint, tick: number, spacing = TICK_SPACING, scale: bigint = WAD,
): { lower: number; underMarket: boolean } | null {
  // `scale` is the contract's fixed point: 1e18 for CUBIT and v1 children (BandLib), 1e36 for a launchpad v2 child
  // (QuoteBandLib.PRICE_SCALE), whose 6- and 8-decimal quotes lose every digit at 1e18.
  const priceAt = (sqrt: bigint) => (sqrt === 0n ? 0n : mulDiv(mulDiv(scale, Q96, sqrt), Q96, sqrt));
  const base = priceAt(launchSqrtPriceX96);
  const current = priceAt(sqrtPriceX96);
  // Rounded exactly like each library: BandLib divides the weighted sum once, QuoteBandLib each weight.
  const target = scale === WAD
    ? (current * (10_000n - WALL_RETRACEMENT_BPS) + base * WALL_RETRACEMENT_BPS) / 10_000n
    : mulDiv(current, 10_000n - WALL_RETRACEMENT_BPS, 10_000n) + mulDiv(base, WALL_RETRACEMENT_BPS, 10_000n);
  let lower = wallTarget(target, scale, MIN_TICK, spacing);
  let underMarket = false;
  if (tick >= lower) {
    lower = wallTarget(mulDiv(current, 10_000n - WALL_UNDER_MARKET_BPS, 10_000n), scale, MIN_TICK, spacing);
    underMarket = true;
  }
  return tick >= lower ? null : { lower, underMarket };
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** v4-core SqrtPriceMath.getAmount0Delta: the ETH (currency0) between two sqrt prices for `liquidity`. */
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp = false): bigint {
  const [low, high] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (low <= 0n) throw new Error("Invalid price.");
  const product = (liquidity << 96n) * (high - low);
  return roundUp ? ceilDiv(ceilDiv(product, high), low) : product / high / low;
}

/** v4-core SqrtPriceMath.getAmount1Delta: the CUBIT (currency1) between two sqrt prices for `liquidity`. */
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp = false): bigint {
  const product = liquidity * (sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA);
  return product / Q96 + (roundUp && product % Q96 !== 0n ? 1n : 0n);
}

/** BandLib.amountsForLiquidity: what a position holds at `sqrtPriceX96`, rounded down like CubitLens. */
export function positionAmounts(sqrtPriceX96: bigint, lower: number, upper: number, liquidity: bigint): { eth: bigint; cubit: bigint } {
  if (liquidity === 0n) return { eth: 0n, cubit: 0n };
  const sqrtA = sqrtPriceAtTick(lower);
  const sqrtB = sqrtPriceAtTick(upper);
  if (sqrtPriceX96 <= sqrtA) return { eth: amount0Delta(sqrtA, sqrtB, liquidity), cubit: 0n };
  if (sqrtPriceX96 < sqrtB) return { eth: amount0Delta(sqrtPriceX96, sqrtB, liquidity), cubit: amount1Delta(sqrtA, sqrtPriceX96, liquidity) };
  return { eth: 0n, cubit: amount1Delta(sqrtA, sqrtB, liquidity) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Token-first children (launchpad v3, CubitTokenFirstHook): the child token is currency0 and its ERC-20 quote
// currency1, so the pool price is quote per token and moves WITH the token price (TokenFirstBandLib).

/** The token's price in human quote units per token, whatever the pool orientation. */
export function quotePriceOf(sqrtPriceX96: bigint, quoteDecimals: number, tokenFirst = false): number {
  if (!tokenFirst) return sqrtPriceToQuotePrice(sqrtPriceX96, quoteDecimals);
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * 10 ** (18 - quoteDecimals);
}

/** TokenFirstBandLib.priceAtSqrt: quote per token, at 1e36. */
export const tokenFirstPriceAtSqrt = (sqrt: bigint): bigint => mulDiv(mulDiv(QUOTE_PRICE_SCALE, sqrt, Q96), sqrt, Q96);

/** TokenFirstBandLib.wallUpper: the upper tick of the one-spacing wall whose every price is strictly under `target`. */
export function tokenFirstWallUpper(target: bigint, spacing = TICK_SPACING): number {
  const minUpper = Math.ceil(MIN_TICK / spacing) * spacing + spacing;
  const maxUpper = Math.floor(MAX_TICK / spacing) * spacing;
  const sqrtX96 = target === 0n ? 0n : isqrt((target << 128n) / QUOTE_PRICE_SCALE) << 32n;
  if (sqrtX96 < MIN_SQRT_PRICE) return minUpper;
  const t = sqrtX96 >= MAX_SQRT_PRICE ? MAX_TICK : tickAtSqrtPrice(sqrtX96);
  let upper = floorToSpacing(t, spacing);
  if (sqrtX96 < MAX_SQRT_PRICE && sqrtPriceAtTick(upper) >= sqrtX96) upper -= spacing;
  if (upper > maxUpper) upper = maxUpper;
  if (upper < minUpper) upper = minUpper;
  return upper;
}

/** CubitTokenFirstHook._placeWall as a prediction: the next sale's wall, as its LOWER tick (the wall spans one spacing
 *  up from it and its highest price is at `lower + spacing`), or null when no wall fits under the price. */
export function nextWallTickTokenFirst(
  launchSqrtPriceX96: bigint, sqrtPriceX96: bigint, tick: number, spacing = TICK_SPACING,
): { lower: number; underMarket: boolean } | null {
  const current = tokenFirstPriceAtSqrt(sqrtPriceX96);
  const target = mulDiv(current, 10_000n - WALL_RETRACEMENT_BPS, 10_000n) + mulDiv(tokenFirstPriceAtSqrt(launchSqrtPriceX96), WALL_RETRACEMENT_BPS, 10_000n);
  let upper = tokenFirstWallUpper(target, spacing);
  let underMarket = false;
  if (upper > tick) {
    upper = tokenFirstWallUpper(mulDiv(current, 10_000n - WALL_UNDER_MARKET_BPS, 10_000n), spacing);
    underMarket = true;
  }
  return upper > tick ? null : { lower: upper - spacing, underMarket };
}
