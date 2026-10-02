import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, keccak256, concat, zeroAddress, type Address } from "viem";
import {
  childQuoteHookInitCodeHash, CUBIT_TAXES, LAUNCH_TAXES, launchpadV2Configured, launchV2Request, linkedQuoteHookCreationCode,
  mineTokenSalt, TAX_BOUNDS, taxesValid,
} from "../src/chain/launchpadV2.ts";
import { marketKey, poolIdOf, poolKeyOf } from "../src/chain/market.ts";
import { formatUnitsDec, parseUnitsDec, sqrtPriceToQuotePrice, Q96 } from "../src/chain/math.ts";
import { QUOTE_HOOK_LINK_REFERENCES } from "../src/chain/bytecode.ts";
import { predictChildToken } from "../src/chain/launchpad.ts";
import { address } from "./helpers.ts";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const TSLAON = "0xf6b1117ec07684D3958caD8BEb1b302bfD21103f" as Address;

test("taxes: QuoteTaxes' bounds, inclusive, and nothing else", () => {
  assert.ok(taxesValid(CUBIT_TAXES));
  assert.ok(taxesValid({ buyTeamBps: 0, sellTeamBps: 0, sellWallBps: 0 }));
  assert.ok(taxesValid({ buyTeamBps: 500, sellTeamBps: 500, sellWallBps: 2_000 }));
  assert.ok(!taxesValid({ buyTeamBps: 501, sellTeamBps: 0, sellWallBps: 0 }));
  assert.ok(!taxesValid({ buyTeamBps: 0, sellTeamBps: 501, sellWallBps: 0 }));
  assert.ok(!taxesValid({ buyTeamBps: 0, sellTeamBps: 0, sellWallBps: 2_001 }));
  assert.ok(!taxesValid({ buyTeamBps: 1.5, sellTeamBps: 0, sellWallBps: 0 }), "fractions of a basis point");
  assert.ok(!taxesValid({ buyTeamBps: -1, sellTeamBps: 0, sellWallBps: 0 }));
  assert.ok(!taxesValid({ buyTeamBps: Number.NaN, sellTeamBps: 0, sellWallBps: 0 }));
  assert.equal(TAX_BOUNDS.sellTeamBps + TAX_BOUNDS.sellWallBps, TAX_BOUNDS.sellTotalBps);
});

test("the default launch rates are CUBIT's: 3% buy, 3% + 12% sell", () => {
  assert.deepEqual(LAUNCH_TAXES, { buyTeamBps: 300, sellTeamBps: 300, sellWallBps: 1_200 });
});

test("the hook's constructor suffix is eight static words, the taxes struct inline", () => {
  const code = "0x6000" as const;
  const taxes = { buyTeamBps: 100, sellTeamBps: 250, sellWallBps: 700 };
  const flat = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "uint16" }, { type: "uint16" }, { type: "uint16" }],
    [address(1), address(2), address(3), USDC, 15_000_000_000n, 100, 250, 700],
  );
  assert.equal((flat.length - 2) / 2, 8 * 32);
  assert.equal(childQuoteHookInitCodeHash(code, address(1), address(2), address(3), USDC, 15_000_000_000n, taxes), keccak256(concat([code, flat])));
  // Each rate changes the hook's address: the hook commits to its taxes.
  const base = childQuoteHookInitCodeHash(code, address(1), address(2), address(3), USDC, 1n, CUBIT_TAXES);
  for (const t of [{ ...CUBIT_TAXES, buyTeamBps: 301 }, { ...CUBIT_TAXES, sellTeamBps: 301 }, { ...CUBIT_TAXES, sellWallBps: 1_201 }]) {
    assert.notEqual(childQuoteHookInitCodeHash(code, address(1), address(2), address(3), USDC, 1n, t), base);
  }
});

test("the quote hook links BandLib and QuoteWallLib, and refuses a missing library", () => {
  assert.deepEqual(Object.keys(QUOTE_HOOK_LINK_REFERENCES).sort(), ["BandLib", "QuoteWallLib"]);
  const linked = linkedQuoteHookCreationCode({ bandLib: address(0xb1), quoteWallLib: address(0xc2) });
  assert.ok(!linked.includes("__$"), "a placeholder is left");
  assert.ok(linked.toLowerCase().includes(address(0xc2).slice(2)));
  assert.throws(() => linkedQuoteHookCreationCode({ bandLib: address(0xb1), quoteWallLib: zeroAddress }), /Unknown library QuoteWallLib/);
});

test("pool keys and ids put the quote in currency0; ETH stays the default", () => {
  const token = address(0xabc);
  const hook = address(0xdef);
  assert.equal(poolKeyOf(token, hook).currency0, zeroAddress);
  assert.equal(poolIdOf(token, hook), poolIdOf(token, hook, zeroAddress), "the v1 pool id is unchanged");
  assert.notEqual(poolIdOf(token, hook, USDC), poolIdOf(token, hook));
  const ref = { token, hook, poolId: poolIdOf(token, hook, USDC), name: "T", symbol: "T", fromBlock: 0n, parent: false,
    quote: { address: USDC, symbol: "USDC", decimals: 6 } };
  assert.equal(marketKey(ref).currency0, USDC);
  assert.equal(marketKey({ ...ref, quote: undefined }).currency0, zeroAddress);
});

test("amounts in the quote's own decimals", () => {
  assert.equal(parseUnitsDec("15000", 6), 15_000_000_000n);
  assert.equal(parseUnitsDec("0.15", 8), 15_000_000n);
  assert.equal(parseUnitsDec("1.1234567", 6), 1_123_456n, "extra digits are truncated, never rounded up");
  assert.equal(parseUnitsDec("abc", 6), 0n);
  assert.equal(formatUnitsDec(15_000_000_000n, 6), "15000");
  assert.equal(formatUnitsDec(15_000_000n, 8, 8), "0.15");
  assert.equal(formatUnitsDec(1n, 6), "0.000001");
});

test("the displayed price is in human quote units per token", () => {
  // Pool price p = token base units per quote base unit; sqrtP = sqrt(p) * 2^96.
  const sqrtFor = (tokensPerQuoteUnit: number) => BigInt(Math.round(Math.sqrt(tokensPerQuoteUnit) * Number(Q96)));
  // 21M tokens (21e24 base units) for 15,000 USDC (15e9 base units): 0.000714… USDC per token.
  const usdc = sqrtPriceToQuotePrice(sqrtFor(21e24 / 15e9), 6);
  assert.ok(Math.abs(usdc / (15_000 / 21_000_000) - 1) < 1e-9);
  // 21M tokens for 3.75 ETH.
  const eth = sqrtPriceToQuotePrice(sqrtFor(21e24 / 3.75e18), 18);
  assert.ok(Math.abs(eth / (3.75 / 21_000_000) - 1) < 1e-9);
});

test("the ETH fee plus the buy is sent only for an ETH pair", () => {
  const p = { name: "T", symbol: "T", team: address(1), quote: zeroAddress, tokenSalt: `0x${"00".repeat(32)}` as const,
    hookSalt: `0x${"00".repeat(32)}` as const, buyAmount: 10n, taxes: CUBIT_TAXES };
  assert.equal(launchV2Request(address(9), 5n, p, "0x").value, 15n);
  assert.equal(launchV2Request(address(9), 5n, { ...p, quote: USDC }, "0x").value, 5n);
});

test("the token salt gives a token above the quote with no code, even under TSLAon's high address", async () => {
  const client = { getCode: async () => "0x" } as never;
  const forge = address(0xf0);
  const mined = await mineTokenSalt({ client }, forge, address(0x11), "Child", "CHLD", TSLAON, 0n);
  assert.ok(BigInt(mined.token) > BigInt(TSLAON));
  assert.equal(predictChildToken(forge, address(0x11), mined.salt, "Child", "CHLD"), mined.token);
  // A token already deployed at the candidate is skipped.
  let first = true;
  const busy = { getCode: async () => { const code = first ? "0x60" : "0x"; first = false; return code; } } as never;
  const next = await mineTokenSalt({ client: busy }, forge, address(0x11), "Child", "CHLD", zeroAddress, 0n);
  assert.equal(next.tries, 2);
});

test("a build without a launchpad v2 manifest does not show it", () => {
  assert.equal(launchpadV2Configured({ forgeV2: zeroAddress }), false);
  assert.equal(launchpadV2Configured({ forgeV2: address(5) }), true);
});

// ---------------------------------------------------------------------------------------------------------------- ETH route
import { decodeAbiParameters, decodeFunctionData } from "viem";
import { bestEthRoute, candidatePaths, describePath } from "../src/chain/ethRoute.ts";
import { encodeV3Path, universalRouterEthBuy, universalRouterEthToQuote, CONTRACT_BALANCE } from "../src/chain/swapEncoding.ts";
import { universalRouterAbi } from "../src/chain/peripheryAbi.ts";

const ROUTE = { weth: address(0xe7), v3Quoter: address(0x9a), routeHub: USDC };

test("v3 paths are packed token, fee, token; malformed paths are refused", () => {
  const packed = encodeV3Path({ tokens: [address(1), USDC, TSLAON], fees: [500, 10_000] });
  assert.equal((packed.length - 2) / 2, 20 + 3 + 20 + 3 + 20);
  assert.equal(packed.slice(42, 48), "0001f4");
  assert.throws(() => encodeV3Path({ tokens: [address(1)], fees: [] }));
  assert.throws(() => encodeV3Path({ tokens: [address(1), USDC], fees: [500, 3_000] }));
});

test("route candidates: direct from WETH, and through USDC unless the pair is USDC", () => {
  const stock = candidatePaths(ROUTE, TSLAON);
  assert.equal(stock.length, 4 + 3 * 4);
  assert.ok(stock.some((p) => p.tokens.length === 3 && p.tokens[1] === USDC));
  assert.equal(candidatePaths(ROUTE, USDC).length, 4, "no hop through itself");
  assert.equal(candidatePaths(ROUTE, zeroAddress).length, 0, "ETH needs no route");
});

test("the best route is the one giving the most of the pair; missing pools are skipped", async () => {
  const outs = new Map<string, bigint>([["500-10000", 90n], ["3000-10000", 120n], ["3000", 100n]]);
  let calls = 0;
  const client = { simulateContract: async (args: { args: [string, bigint] }) => {
    calls++;
    const hex = args.args[0].slice(2);
    const fees = hex.length === 86 ? [parseInt(hex.slice(40, 46), 16)] : [parseInt(hex.slice(40, 46), 16), parseInt(hex.slice(86, 92), 16)];
    const out = outs.get(fees.join("-"));
    if (out === undefined) throw new Error("no pool");
    return { result: [out, [], [], 150_000n] };
  } } as never;
  const best = await bestEthRoute(client, ROUTE, TSLAON, 10n ** 18n, undefined, 1_000);
  assert.equal(best?.out, 120n);
  assert.deepEqual(best?.path.fees, [3_000, 10_000]);
  const before = calls;
  await bestEthRoute(client, ROUTE, TSLAON, 10n ** 18n, undefined, 2_000);
  assert.equal(calls - before, 1, "a kept route costs one quote");
  const empty = { simulateContract: async () => { throw new Error("no pool"); } } as never;
  assert.equal(await bestEthRoute(empty, ROUTE, address(0x77), 10n ** 18n, undefined, 1_000), null, "no pool at all: no route");
  assert.equal(describePath(best!.path, { [ROUTE.weth.toLowerCase()]: "ETH", [USDC.toLowerCase()]: "USDC", [TSLAON.toLowerCase()]: "TSLAon" }),
    "ETH → USDC (0.3%) → TSLAon (1%)");
});

test("an ETH buy wraps, swaps to the pair held by the router, then settles it all into the child's pool", () => {
  const ref = { token: address(0xabc), hook: address(0xdef), poolId: poolIdOf(address(0xabc), address(0xdef), TSLAON), name: "T", symbol: "T",
    fromBlock: 0n, parent: false, quote: { address: TSLAON, symbol: "TSLAon", decimals: 18 } };
  const path = { tokens: [ROUTE.weth, USDC, TSLAON], fees: [500, 10_000] };
  const req = universalRouterEthBuy(address(0x99), ref, path, 10n ** 16n, 5n, 1_000n);
  assert.equal(req.value, 10n ** 16n);
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data: encodeFunctionDataOf(req) });
  assert.equal(args[0], "0x0b0010", "WRAP_ETH, V3_SWAP_EXACT_IN, V4_SWAP");
  assert.ok(args[1][2].includes(CONTRACT_BALANCE.toString(16)), "SETTLE uses the router's whole balance");
  assert.throws(() => universalRouterEthBuy(address(0x99), ref, { tokens: [ROUTE.weth, USDC], fees: [500] }, 1n, 1n, 1n), /does not end/);
  const toQuote = universalRouterEthToQuote(address(0x99), path, 7n, 3n, 1_000n);
  assert.equal(toQuote.value, 7n);
  assert.equal(decodeFunctionData({ abi: universalRouterAbi, data: encodeFunctionDataOf(toQuote) }).args[0], "0x0b00");
});

import { encodeFunctionData } from "viem";
function encodeFunctionDataOf(req: { abi: unknown; functionName: string; args?: readonly unknown[] }) {
  return encodeFunctionData(req as never);
}

// ------------------------------------------------------------------------------------------ approvals, first buys, transactions
import { approveNoReturnAbi } from "../src/chain/peripheryAbi.ts";
import { quoteApproveRequest, parseFirstBuy, firstBuyFromSwap, estimateStillHolds } from "../src/chain/launchpadV2.ts";
import { replacementFailure } from "../src/chain/txSequence.ts";
import { isTransportError } from "../src/chain/ethRoute.ts";
import { nextWallTick, QUOTE_PRICE_SCALE } from "../src/chain/math.ts";
import { decodeFunctionResult, HttpRequestError, ContractFunctionRevertedError, BaseError } from "viem";

test("a pair's approval decodes USDT's empty return (the simulation used to refuse it)", () => {
  const req = quoteApproveRequest(USDC, address(9), 5n);
  assert.equal(req.abi, approveNoReturnAbi);
  assert.equal(decodeFunctionResult({ abi: approveNoReturnAbi, functionName: "approve", data: "0x" }), undefined);
  assert.doesNotThrow(() => decodeFunctionResult({ abi: approveNoReturnAbi, functionName: "approve", data: `0x${"00".repeat(31)}01` }));
});

test("the first-buy field: empty is no buy; a typo or dust below one unit is refused, never a launch without its buy", () => {
  assert.deepEqual(parseFirstBuy("", 6), { units: 0n, invalid: false });
  assert.deepEqual(parseFirstBuy("0", 6), { units: 0n, invalid: false });
  assert.deepEqual(parseFirstBuy("12.5", 6), { units: 12_500_000n, invalid: false });
  assert.deepEqual(parseFirstBuy(".5", 8), { units: 50_000_000n, invalid: false });
  assert.equal(parseFirstBuy("1e-3", 18).invalid, true);
  assert.equal(parseFirstBuy("0.0000001", 6).invalid, true, "below one base unit");
  assert.equal(parseFirstBuy("1.1234567", 6).invalid, true, "a non-zero digit past the decimals");
  assert.equal(parseFirstBuy("1.1234560", 6).invalid, false, "a trailing zero is fine");
  assert.equal(parseFirstBuy(".", 6).invalid, true);
  assert.equal(parseFirstBuy("1,5", 6).invalid, true);
});

test("a first buy paid with ETH: 99% of the swap, and a fresh quote may not fall more than 2% under the estimate", () => {
  assert.equal(firstBuyFromSwap(1_000n), 990n);
  assert.equal(estimateStillHolds(100n, 98n), true);
  assert.equal(estimateStillHolds(100n, 97n), false);
  assert.equal(estimateStillHolds(100n, 150n), true);
});

test("a cancelled or replaced transaction stops the sequence; a speed-up does not", () => {
  assert.match(replacementFailure("cancelled")!, /cancelled/);
  assert.match(replacementFailure("replaced")!, /replaced/);
  assert.equal(replacementFailure("repriced"), null);
  assert.equal(replacementFailure(null), null);
});

test("an endpoint failure is an error, a reverting quote is 'no route'", async () => {
  const http = new HttpRequestError({ url: "https://rpc.invalid", status: 429 });
  assert.equal(isTransportError(http), true);
  assert.equal(isTransportError(new BaseError("wrapped", { cause: http })), true);
  assert.equal(isTransportError(new ContractFunctionRevertedError({ abi: [], functionName: "quoteExactInput" })), false);
  const down = { simulateContract: async () => { throw http; } } as never;
  await assert.rejects(bestEthRoute(down, ROUTE, address(0x78), 10n ** 18n, undefined, 5_000));
});

// QuoteBandLib's own choice (retracement target, else 1% under the market), computed by the contract:
// [launch sqrtPriceX96, pool tick, pool sqrtPriceX96, wall lower tick, under the market].
const QUOTE_WALL_VECTORS: [string, number, string, number, boolean][] = [
  ["93744026100554018552920879165675143168", 417850, "93739666109118747874024715789073556358", 417860, false],
  ["93744026100554018552920879165675143168", 417790, "93458882535673377160900713472186410944", 417830, false],
  ["93744026100554018552920879165675143168", 417960, "94256628769221063654284649933254478331", 418070, true],
  ["93744026100554018552920879165675143168", 412850, "73005437872071045578829156254191311317", 415550, false],
  ["93744026100554018552920879165675143168", 377850, "12687552870665620601517318044456300443", 386750, false],
  ["2964446395120234429868253507728965632", 348769, "2964309499725285076880260176202263816", 348770, false],
  ["2964446395120234429868253507728965632", 348709, "2955430340574429536500722459342339665", 348750, false],
  ["2964446395120234429868253507728965632", 348879, "2980657299839707255459582885540405866", 348980, true],
  ["2964446395120234429868253507728965632", 343769, "2308635415490694152845967878251131635", 346470, false],
  ["2964446395120234429868253507728965632", 308769, "401215782644251650433588730544557080", 317670, false],
  ["187488052201108037105841172643840", 155390, "187482985038190158235397220892952", 155400, false],
  ["187488052201108037105841172643840", 155330, "186921406949807068551783514791926", 155370, false],
  ["187488052201108037105841172643840", 155500, "188516930503244862176523279170642", 155610, true],
  ["187488052201108037105841172643840", 150390, "146013720598739733267308922369680", 153090, false],
  ["187488052201108037105841172643840", 115390, "25375600146188865495814792894580", 124290, false],
  ["61369870793672105125737725427712", 133053, "61368331814618212061382185342101", 133060, false],
  ["61369870793672105125737725427712", 132993, "61184511877781318151657252860185", 133030, false],
  ["61369870793672105125737725427712", 133163, "61706770571419378743268747064119", 133270, true],
  ["61369870793672105125737725427712", 128053, "47794302258229685102268364537927", 130750, false],
  ["61369870793672105125737725427712", 93053, "8306131084104406844752682924440", 101950, false],
];

test("the next wall of a launchpad v2 child is predicted at the contract's 1e36 precision, for 6, 8 and 18 decimals", () => {
  for (const [launch, tick, sqrt, lower, under] of QUOTE_WALL_VECTORS) {
    assert.deepEqual(nextWallTick(BigInt(launch), BigInt(sqrt), tick, 10, QUOTE_PRICE_SCALE), { lower, underMarket: under }, `tick ${tick}`);
  }
  // At 1e18 the WBTC prediction loses every digit (the precision this test guards).
  const [launch, tick, sqrt] = QUOTE_WALL_VECTORS[2];
  assert.notDeepEqual(nextWallTick(BigInt(launch), BigInt(sqrt), tick, 10), nextWallTick(BigInt(launch), BigInt(sqrt), tick, 10, QUOTE_PRICE_SCALE));
});

test("an ETH buy's Universal Router inputs, field by field", () => {
  const ref = { token: address(0xabc), hook: address(0xdef), poolId: poolIdOf(address(0xabc), address(0xdef), TSLAON), name: "T", symbol: "T",
    fromBlock: 0n, parent: false, quote: { address: TSLAON, symbol: "TSLAon", decimals: 18 } };
  const path = { tokens: [ROUTE.weth, USDC, TSLAON], fees: [500, 10_000] };
  const req = universalRouterEthBuy(address(0x99), ref, path, 10n ** 16n, 777n, 1_000n);
  const [, inputs, deadline] = decodeFunctionData({ abi: universalRouterAbi, data: encodeFunctionDataOf(req) }).args;
  assert.equal(deadline, 1_000n);
  const [wrapTo, wrapAmount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], inputs[0]);
  assert.equal(wrapTo, "0x0000000000000000000000000000000000000002", "wrapped for the router itself");
  assert.equal(wrapAmount, 10n ** 16n);
  const [v3To, v3In, v3Min, v3Path, payer] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }], inputs[1]);
  assert.equal(v3To, "0x0000000000000000000000000000000000000002");
  assert.equal(v3In, 10n ** 16n);
  assert.equal(v3Min, 0n, "only the final output is bounded");
  assert.equal(v3Path, encodeV3Path(path));
  assert.equal(payer, false, "paid from the router's WETH");
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[2]);
  assert.equal(actions, "0x0b060f", "SETTLE, SWAP_EXACT_IN_SINGLE, TAKE_ALL");
  const [settleCurrency, settleAmount, settlePayer] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], params[0]);
  assert.equal(settleCurrency, TSLAON);
  assert.equal(settleAmount, CONTRACT_BALANCE);
  assert.equal(settlePayer, false);
  const [swap] = decodeAbiParameters([{ type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
    { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }], params[1]);
  assert.equal(swap.poolKey.currency0, TSLAON);
  assert.equal(swap.zeroForOne, true);
  assert.equal(swap.amountIn, 0n, "OPEN_DELTA: the whole credit");
  assert.equal(swap.amountOutMinimum, 777n);
  const [takeToken, takeMin] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]);
  assert.equal(takeToken.toLowerCase(), ref.token.toLowerCase());
  assert.equal(takeMin, 777n);
  const toQuote = universalRouterEthToQuote(address(0x99), path, 7n, 3n, 1_000n);
  const [, qInputs] = decodeFunctionData({ abi: universalRouterAbi, data: encodeFunctionDataOf(toQuote) }).args;
  const [recipient, , min] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }], qInputs[1]);
  assert.equal(recipient, "0x0000000000000000000000000000000000000001", "the pair goes to the caller");
  assert.equal(min, 3n, "the swap's floor is the launch's buy");
});

// ------------------------------------------------------------------------------------ launchpad v3: token-first pools
import { zeroForOneOf } from "../src/chain/market.ts";
import { universalRouterSwap } from "../src/chain/swapEncoding.ts";
import { quotePriceOf, nextWallTickTokenFirst, sqrtPriceAtTick as atTick } from "../src/chain/math.ts";
import { linkedTokenFirstHookCreationCode, isTokenFirst } from "../src/chain/launchpadV2.ts";
import { TOKEN_FIRST_HOOK_LINK_REFERENCES } from "../src/chain/bytecode.ts";

test("a token-first pool puts the token in currency0; buys are oneForZero; an ETH pair never is token-first", () => {
  const key = poolKeyOf(address(0x10), address(0x20), TSLAON, true);
  assert.equal(key.currency0, address(0x10));
  assert.equal(key.currency1, TSLAON);
  assert.notEqual(poolIdOf(address(0x10), address(0x20), TSLAON, true), poolIdOf(address(0x10), address(0x20), TSLAON));
  const ref = { token: address(0x10), hook: address(0x20), poolId: poolIdOf(address(0x10), address(0x20), TSLAON, true), name: "T",
    symbol: "T", fromBlock: 0n, parent: false, quote: { address: TSLAON, symbol: "TSLAon", decimals: 18 }, tokenFirst: true };
  assert.equal(zeroForOneOf(ref, true), false, "buy = quote (currency1) in");
  assert.equal(zeroForOneOf(ref, false), true);
  assert.equal(zeroForOneOf({ ...ref, tokenFirst: false }, true), true);
  assert.equal(isTokenFirst({ tokenFirst: true }, zeroAddress), false);
  assert.equal(isTokenFirst({ tokenFirst: true }, USDC), true);
  assert.equal(isTokenFirst({ tokenFirst: false }, USDC), false);
  const buy = universalRouterSwap(address(0x99), ref, true, 10n, 1n, 1_000n);
  const [, inputs] = decodeFunctionData({ abi: universalRouterAbi, data: encodeFunctionDataOf(buy) }).args;
  const [, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]);
  const [swap] = decodeAbiParameters([{ type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
    { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }], params[0]);
  assert.equal(swap.zeroForOne, false);
  assert.equal(swap.poolKey.currency0.toLowerCase(), address(0x10).toLowerCase());
  const [paid] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]);
  assert.equal(paid, TSLAON, "a buy settles the pair");
});

test("token-first prices read quote per token, the mirror of the quote-first reading", () => {
  const sqrt = atTick(-120_000);
  assert.ok(Math.abs(quotePriceOf(sqrt, 18, true) / quotePriceOf(atTick(120_000), 18, false) - 1) < 1e-9);
});

test("a token-first child's next wall is under the price, 40/60 above launch and 1% under the price below it", () => {
  const launch = atTick(-130_000);
  const above = nextWallTickTokenFirst(launch, atTick(-125_000), -125_000)!;
  assert.ok(above && !above.underMarket && above.lower + 10 <= -125_000 && above.lower > -130_000);
  const below = nextWallTickTokenFirst(launch, atTick(-131_000), -131_000)!;
  assert.ok(below.underMarket && below.lower + 10 <= -131_000 - 100 && below.lower + 10 >= -131_000 - 130, `${below.lower}`);
});

test("the token-first hook links BandLib and TokenFirstWallLib", () => {
  assert.deepEqual(Object.keys(TOKEN_FIRST_HOOK_LINK_REFERENCES).sort(), ["BandLib", "TokenFirstWallLib"]);
  assert.ok(!linkedTokenFirstHookCreationCode({ bandLib: address(0xb1), tokenFirstWallLib: address(0xc3) }).includes("__$"));
  assert.throws(() => linkedTokenFirstHookCreationCode({ bandLib: address(0xb1) }), /Unknown library TokenFirstWallLib/);
});

// ------------------------------------------------------------------------ launcher-chosen fees (/launchpad-custom)
import { parseTaxPercent } from "../src/chain/launchpadV2.ts";
import { CUSTOM_TAXES_PUBLIC } from "../src/launch.ts";

test("the fee fields read percent with two decimals at most, and the Forge's bounds decide", () => {
  assert.equal(parseTaxPercent("3"), 300);
  assert.equal(parseTaxPercent("2.5"), 250);
  assert.equal(parseTaxPercent("12.25"), 1_225);
  assert.equal(parseTaxPercent(" 0 "), 0);
  assert.ok(Number.isNaN(parseTaxPercent("")));
  assert.ok(Number.isNaN(parseTaxPercent("1.234")), "a third decimal is refused, never rounded");
  assert.ok(Number.isNaN(parseTaxPercent("-1")));
  assert.ok(Number.isNaN(parseTaxPercent("3%")));
  const t = (b: string, s: string, w: string) => taxesValid({ buyTeamBps: parseTaxPercent(b), sellTeamBps: parseTaxPercent(s), sellWallBps: parseTaxPercent(w) });
  assert.ok(t("5", "5", "20"), "the maxima");
  assert.ok(t("0", "0", "0"));
  assert.ok(!t("5.01", "0", "0"));
  assert.ok(!t("0", "0", "20.01"));
  assert.ok(!t("x", "3", "12"));
});

test("the custom-fees page is published (release of 30 September 2026)", () => {
  assert.equal(CUSTOM_TAXES_PUBLIC, true);
});
