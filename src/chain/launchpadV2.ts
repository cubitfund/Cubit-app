// Launchpad v2 (CubitForgeV2): children paired with a quote currency — native ETH, or an ERC-20 such as USDC, USDT,
// WBTC or a tokenized stock — with taxes the launcher chooses at launch, frozen in the child's hook. A launch is
// prepared in the browser like script/ForgeV2Launch.s.sol: link the CubitQuoteHook creation code with the deployment's
// BandLib and QuoteWallLib and check it against the Forge's frozen hash; mine a token salt so that the child token's
// address sorts above its quote (the quote must be the pool's currency0); then mine the hook salt the Forge binds to
// the launcher so that the hook's address carries the six hook flags. The v1 launchpad (launchpad.ts) is untouched.
import {
  concat, encodeAbiParameters, getAddress, keccak256, parseAbi, parseEventLogs, toHex, zeroAddress,
  type Address, type Hex, type TransactionReceipt,
} from "viem";
import { CubitForgeV2Abi, CubitForgeV3Abi, CubitQuoteHookAbi, CubitTokenAbi } from "./abi.ts";
import { sameAddress } from "./address.ts";
import { FORGE_TOKEN_CREATION_CODE, QUOTE_HOOK_CREATION_CODE, QUOTE_HOOK_LINK_REFERENCES, TOKEN_FIRST_HOOK_CREATION_CODE, TOKEN_FIRST_HOOK_LINK_REFERENCES } from "./bytecode.ts";
import type { DEPLOYMENT } from "./deployment.ts";
import type { BlockSnapshot, ReadContext } from "./readContext.ts";
import { createLogCursor, type CursorRow, type CursorStore } from "./logCursor.ts";
import { createMetadataCache } from "./tokenMetadata.ts";
import { chunked } from "./events.ts";
import { hasHookFlags, predictChildToken } from "./launchpad.ts";
import { poolIdOf, type MarketRef, type QuoteInfo, type Taxes } from "./market.ts";
import type { WriteRequest } from "./writeRequest.ts";
import { approveNoReturnAbi } from "./peripheryAbi.ts";

export type V2Context = {
  client: ReadContext["client"];
  config: ReadContext["config"] & Pick<typeof DEPLOYMENT, "forgeV2" | "quoteWallLib" | "launchpadV2DeployBlock"> &
    Partial<Pick<typeof DEPLOYMENT, "launchpadV2Version" | "tokenFirstWallLib" | "launchpadV2PreviousForges">>;
};

/** This build knows a launchpad v2 (contracts/deployments/1.launchpad-v2.json was synced). */
export const launchpadV2Configured = (config: Pick<V2Context["config"], "forgeV2">) => config.forgeV2 !== zeroAddress;

/** QuoteTaxes' bounds, in basis points. */
export const TAX_BOUNDS = { buyTeamBps: 500, sellTeamBps: 500, sellWallBps: 2_000, sellTotalBps: 2_500 } as const;
/** CUBIT's own rates: 3% on buys to the team, 15% on sales split 3% team and 12% walls. */
export const CUBIT_TAXES: Taxes = { buyTeamBps: 300, sellTeamBps: 300, sellWallBps: 1_200 };
/** The default taxes of a launch: CUBIT's own rates. The launcher may choose others within TAX_BOUNDS, which the
 *  Forge enforces. */
export const LAUNCH_TAXES: Taxes = CUBIT_TAXES;

export function taxesValid(t: Taxes): boolean {
  const ok = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max;
  return ok(t.buyTeamBps, TAX_BOUNDS.buyTeamBps) && ok(t.sellTeamBps, TAX_BOUNDS.sellTeamBps) &&
    ok(t.sellWallBps, TAX_BOUNDS.sellWallBps) && t.sellTeamBps + t.sellWallBps <= TAX_BOUNDS.sellTotalBps;
}

const erc20MetadataAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const ETH_QUOTE: QuoteInfo = { address: zeroAddress, symbol: "ETH", decimals: 18 };

export type QuoteOption = QuoteInfo & { launchValue: bigint };

export type ForgeV2View = {
  forge: Address;
  launchFee: bigint;
  launches: bigint;
  governanceVault: Address;
  hookCreationCodeHash: Hex;
  /** Launchpad v3 (CubitForgeV3): every ERC-20 pair's token is currency0, with its own hook template. */
  tokenFirst: boolean;
  tokenFirstHookCreationCodeHash: Hex | null;
  /** The creation codes this build links have the hashes the Forge froze (both, for a v3 Forge). */
  templateMatches: boolean;
  poolManager: Address;
  quotes: QuoteOption[];
};

export async function readQuoteInfo({ client }: Pick<V2Context, "client">, quote: Address, blockNumber?: bigint): Promise<QuoteInfo> {
  if (quote === zeroAddress) return ETH_QUOTE;
  const at = { address: quote, abi: erc20MetadataAbi, blockNumber } as const;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ ...at, functionName: "symbol" }),
    client.readContract({ ...at, functionName: "decimals" }),
  ]);
  return { address: getAddress(quote), symbol, decimals: Number(decimals) };
}

export async function readForgeV2(ctx: V2Context, block: BlockSnapshot): Promise<ForgeV2View> {
  const { client, config } = ctx;
  const forge = config.forgeV2;
  const at = { address: forge, abi: CubitForgeV2Abi, blockNumber: block.number } as const;
  const tokenFirst = (config.launchpadV2Version ?? 2) >= 3;
  const [launchFee, launches, governanceVault, hookCreationCodeHash, poolManager, quoteAddresses, tokenFirstHash] = await Promise.all([
    client.readContract({ ...at, functionName: "launchFee" }),
    client.readContract({ ...at, functionName: "launches" }),
    client.readContract({ ...at, functionName: "governanceVault" }),
    client.readContract({ ...at, functionName: "hookCreationCodeHash" }),
    client.readContract({ ...at, functionName: "poolManager" }),
    client.readContract({ ...at, functionName: "quotes" }),
    tokenFirst
      ? client.readContract({ address: forge, abi: CubitForgeV3Abi, functionName: "tokenFirstHookCreationCodeHash", blockNumber: block.number })
      : Promise.resolve(null),
  ]);
  const quotes = await Promise.all(quoteAddresses.map(async (quote): Promise<QuoteOption> => {
    const [info, launchValue] = await Promise.all([
      readQuoteInfo(ctx, quote, block.number),
      client.readContract({ ...at, functionName: "launchValue", args: [quote] }),
    ]);
    return { ...info, launchValue };
  }));
  return {
    forge, launchFee, launches, governanceVault, hookCreationCodeHash, poolManager, quotes, tokenFirst,
    tokenFirstHookCreationCodeHash: tokenFirstHash,
    templateMatches: keccak256(linkedQuoteHookCreationCode(config)) === hookCreationCodeHash.toLowerCase() &&
      (!tokenFirst || (!!tokenFirstHash && keccak256(linkedTokenFirstHookCreationCode(config)) === tokenFirstHash.toLowerCase())),
  };
}

/** CubitQuoteHook creation code with BandLib and QuoteWallLib at the deployment's addresses. */
export function linkedQuoteHookCreationCode(config: Pick<V2Context["config"], "bandLib" | "quoteWallLib">): Hex {
  let code = QUOTE_HOOK_CREATION_CODE.slice(2);
  const addresses: Record<string, string> = { BandLib: config.bandLib, QuoteWallLib: config.quoteWallLib };
  for (const [library, positions] of Object.entries(QUOTE_HOOK_LINK_REFERENCES)) {
    const value = addresses[library]?.slice(2).toLowerCase();
    if (!value || /^0+$/.test(value)) throw new Error(`Unknown library ${library}.`);
    for (const { start, length } of positions) code = code.slice(0, start * 2) + value + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}

/** CubitTokenFirstHook creation code with BandLib and TokenFirstWallLib at the deployment's addresses (launchpad v3). */
export function linkedTokenFirstHookCreationCode(config: Partial<Pick<V2Context["config"], "bandLib" | "tokenFirstWallLib">>): Hex {
  let code = TOKEN_FIRST_HOOK_CREATION_CODE.slice(2);
  const addresses: Record<string, string | undefined> = { BandLib: config.bandLib, TokenFirstWallLib: config.tokenFirstWallLib };
  for (const [library, positions] of Object.entries(TOKEN_FIRST_HOOK_LINK_REFERENCES)) {
    const value = addresses[library]?.slice(2).toLowerCase();
    if (!value || /^0+$/.test(value)) throw new Error(`Unknown library ${library}.`);
    for (const { start, length } of positions) code = code.slice(0, start * 2) + value + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}

/** Whether a child of this Forge paired with `quote` is token-first: a v3 Forge and an ERC-20 pair. */
export const isTokenFirst = (forge: Pick<ForgeV2View, "tokenFirst">, quote: Address) => forge.tokenFirst && quote !== zeroAddress;

/** The hook creation code a launch of `quote` on this Forge must send. */
export const hookCodeFor = (config: V2Context["config"], forge: Pick<ForgeV2View, "tokenFirst">, quote: Address): Hex =>
  isTokenFirst(forge, quote) ? linkedTokenFirstHookCreationCode(config) : linkedQuoteHookCreationCode(config);

/** The first token salt, from `start`, whose child token sorts on the right side of the quote and holds no code yet:
 *  above it (launchpad v2, and native ETH anywhere), or `below` it for a token-first child (launchpad v3). A quote near
 *  the top of the address space needs more tries above it (TSLAon, 0xf6b1…, about 27), one near the bottom more
 *  under it (AAPLon, 0x14c3…, about 12). */
export async function mineTokenSalt(
  { client }: Pick<V2Context, "client">, forge: Address, launcher: Address, name: string, symbol: string, quote: Address,
  start: bigint, cancelled?: () => boolean, below = false,
): Promise<{ salt: Hex; token: Address; tries: number }> {
  for (let i = 0n; i < 1_000_000n; i++) {
    if (cancelled?.()) throw new Error("Launch preparation cancelled.");
    const salt = toHex((start + i) % (1n << 256n), { size: 32 });
    const token = predictChildToken(forge, launcher, salt, name, symbol);
    if (below ? BigInt(token) >= BigInt(quote) : BigInt(token) <= BigInt(quote)) continue;
    const code = await client.getCode({ address: token });
    if (!code || code === "0x") return { salt, token, tries: Number(i) + 1 };
  }
  throw new Error(`No token salt found ${below ? "below" : "above"} this quote.`);
}

/** keccak256 of the child hook's init code: the frozen creation code and its eight-word constructor suffix. */
export function childQuoteHookInitCodeHash(
  creationCode: Hex, poolManager: Address, token: Address, team: Address, quote: Address, launchValue: bigint, taxes: Taxes,
): Hex {
  return keccak256(concat([creationCode, encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" },
      { type: "tuple", components: [{ name: "buyTeamBps", type: "uint16" }, { name: "sellTeamBps", type: "uint16" }, { name: "sellWallBps", type: "uint16" }] }],
    [poolManager, token, team, quote, launchValue, taxes],
  )]));
}

export type LaunchV2Params = {
  name: string;
  symbol: string;
  team: Address;
  quote: Address;
  tokenSalt: Hex;
  hookSalt: Hex;
  buyAmount: bigint;
  taxes: Taxes;
};

/** The fee in ETH, plus the launcher's buy when the pair is native ETH; an ERC-20 buy is pulled with an allowance. */
export function launchV2Request(forge: Address, fee: bigint, p: LaunchV2Params, creationCode: Hex): WriteRequest {
  return {
    address: forge, abi: CubitForgeV2Abi, functionName: "launch", args: [p, creationCode],
    value: fee + (p.quote === zeroAddress ? p.buyAmount : 0n),
  };
}

export async function quoteAllowance({ client }: Pick<V2Context, "client">, quote: Address, owner: Address, spender: Address): Promise<bigint> {
  return client.readContract({ address: quote, abi: erc20MetadataAbi, functionName: "allowance", args: [owner, spender] });
}

/** An exact allowance for the launcher's buy. USDT refuses to change a non-zero allowance: reset it to zero first. */
export const quoteApproveRequest = (quote: Address, spender: Address, amount: bigint): WriteRequest => ({
  address: quote, abi: approveNoReturnAbi, functionName: "approve", args: [spender, amount],
});

export type ChildLaunchV2 = MarketRef & {
  forge: Address; launcher: Address; team: Address; fee: bigint; tx: Hex; quoteIn: bigint; tokensOut: bigint;
  quote: QuoteInfo; taxes: Taxes; tokenFirst: boolean;
};

/** A successful replacement receipt may be a cancellation rather than the prepared launch. */
export function confirmsChildLaunchV2(
  receipt: Pick<TransactionReceipt, "status" | "logs">, expected: { forge: Address; token: Address; hook: Address },
): boolean {
  if (receipt.status !== "success") return false;
  return parseEventLogs({ abi: CubitForgeV2Abi, eventName: "ChildLaunched", logs: receipt.logs, strict: true }).some((log) =>
    sameAddress(log.address, expected.forge) && sameAddress(log.args.token, expected.token) && sameAddress(log.args.hook, expected.hook));
}

export async function readTaxes({ client }: Pick<V2Context, "client">, hook: Address, blockNumber: bigint): Promise<Taxes> {
  const at = { address: hook, abi: CubitQuoteHookAbi, blockNumber } as const;
  const [buy, sellTeam, sellWall] = await Promise.all([
    client.readContract({ ...at, functionName: "BUY_TAX_BPS" }),
    client.readContract({ ...at, functionName: "SELL_TEAM_BPS" }),
    client.readContract({ ...at, functionName: "SELL_FLOOR_BPS" }),
  ]);
  return { buyTeamBps: Number(buy), sellTeamBps: Number(sellTeam), sellWallBps: Number(sellWall) };
}

/** Children of the configured launchpad v2, from its `ChildLaunched` events, with their quote and taxes. */
export function createLaunchpadV2Reader(ctx: V2Context, store?: CursorStore) {
  const { client, config } = ctx;
  const metadata = createMetadataCache(store);
  const quotes = new Map<string, QuoteInfo>();
  const taxes = new Map<string, Taxes>();
  const hashAt = async (number: bigint) => (await client.getBlock({ blockNumber: number })).hash;
  type Launch = CursorRow & {
    token: Address; hook: Address; launcher: Address; quote: Address; team: Address; fee: bigint; quoteIn: bigint;
    tokensOut: bigint; tx: Hex;
  };
  // The Forge in force and every earlier launchpad v2/v3 Forge: their children keep trading (same event signature).
  const forges = config.forgeV2 === zeroAddress || config.launchpadV2DeployBlock === null ? []
    : [{ forge: config.forgeV2, deployBlock: config.launchpadV2DeployBlock, version: config.launchpadV2Version ?? 2 },
      ...(config.launchpadV2PreviousForges ?? [])];
  const cursors = forges.map(({ forge, deployBlock, version }) => ({ forge, version,
    cursor: createLogCursor<Launch>(deployBlock, (from, to) => chunked(from, to, async (lo, hi) => {
      const logs = await client.getContractEvents({ address: forge, abi: CubitForgeV2Abi, eventName: "ChildLaunched", fromBlock: lo, toBlock: hi });
      return logs.map((log) => ({
        ...log.args as Omit<Launch, keyof CursorRow | "tx">,
        id: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber!, blockHash: log.blockHash!, tx: log.transactionHash!,
      }));
    }), hashAt, store ? { store, key: `launches-v2:${forge}` } : undefined) }));

  return async function readAllChildrenV2(block: BlockSnapshot): Promise<ChildLaunchV2[]> {
    if (!cursors.length) return [];
    const logs = (await Promise.all(cursors.map(async ({ forge, version, cursor }) =>
      (await cursor.read(block)).map((log) => ({ ...log, forge, tokenFirst: version >= 3 && log.quote !== zeroAddress }))))).flat();
    const children: ChildLaunchV2[] = [];
    for (let i = 0; i < logs.length; i += 8) {
      children.push(...await Promise.all(logs.slice(i, i + 8).map(async (log): Promise<ChildLaunchV2> => {
        const names = await metadata.read(config.chainId, log.token, async () => {
          const at = { address: log.token, abi: CubitTokenAbi, blockNumber: block.number } as const;
          const [name, symbol] = await Promise.all([client.readContract({ ...at, functionName: "name" }), client.readContract({ ...at, functionName: "symbol" })]);
          return { name, symbol };
        }, log.blockHash);
        const quoteKey = log.quote.toLowerCase();
        if (!quotes.has(quoteKey)) quotes.set(quoteKey, await readQuoteInfo(ctx, log.quote, block.number));
        const hookKey = log.hook.toLowerCase();
        if (!taxes.has(hookKey)) taxes.set(hookKey, await readTaxes(ctx, log.hook, block.number));
        const quote = quotes.get(quoteKey)!;
        return {
          ...log, ...names, quote, taxes: taxes.get(hookKey)!,
          poolId: poolIdOf(log.token, log.hook, log.quote, log.tokenFirst), fromBlock: BigInt(log.block), parent: false,
        };
      })));
    }
    return children.sort((a, b) => a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0);
  };
}

/** The launch form's first-buy field: empty or zero is "no buy"; anything else must be a number with at most
 *  `decimals` decimals and worth at least one base unit, so a typo never becomes a launch without its buy. */
export function parseFirstBuy(text: string, decimals: number): { units: bigint; invalid: boolean } {
  const t = text.trim();
  if (t === "") return { units: 0n, invalid: false };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { units: 0n, invalid: true };
  const frac = m[2] ?? "";
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return { units: 0n, invalid: true };
  const units = BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return { units, invalid: false };
}

/** A first buy paid with ETH: the Forge pulls exactly this much of the swap's output, which is also the swap's floor;
 *  the 1% above it stays in the wallet. */
export const firstBuyFromSwap = (routeOut: bigint) => (routeOut * 99n) / 100n;

/** The fresh quote at launch may not give materially less than the estimate the user saw (2% tolerance). */
export const estimateStillHolds = (shown: bigint, fresh: bigint) => fresh * 100n >= shown * 98n;

/** A tax field of the launch form, in percent with at most two decimals ("3", "2.5", "12.25"): basis points, or NaN. */
export function parseTaxPercent(text: string): number {
  const t = text.trim();
  return /^\d{1,3}(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : Number.NaN;
}
