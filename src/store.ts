import { CUBIT, publicData } from "./chain/appChain";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { createBlockTimes, buildSeries, emptyHistory, type MarketEvent, type MarketHistory, type SeriesPoint } from "./chain/events";
import { CONFIG, shortAddress } from "./chain/config";
import { type MarketState, type WallState } from "./chain/market";
import { sqrtPriceAtTick, sqrtPriceToWadPrice, tokensToNumber, wadToNumber, weiToEth } from "./chain/math";
import { connectWallet, disconnectWallet, startWalletDiscovery, switchToAppChain, useWallet, type WalletInfo } from "./chain/wallet";
import { usePoll } from "./chain/usePoll";
import { fmtEth, fmtEthAmount, fmtInt } from "./format";

// ===========================================================================
// STORE = THE SINGLE SOURCE OF TRUTH — LIVE
// ---------------------------------------------------------------------------
// Every figure comes from the CUBIT contracts on Ethereum: one read of the market per refresh (registry, Lens, hook,
// walls, vault, at one block) plus the indexed history (hook events and pool swaps). Nothing is simulated.
// PROTOCOL MODEL: no burn (launch rounding dust only), no rebalance, no keepers.
//   • Fixed 21M supply. The Band: one wide position with 80% of the supply, placed once, never withdrawn.
//   • Walls: every SELL places an ETH-only buy wall under the price with 12% of the sale, at 0.4·market + 0.6·launch,
//     or 1% under the price at or below launch. Merged per tick, never moved.
//   • Crossed walls: their CUBIT go to the Vault reward reserve (not burned); a wall only entered stays in place.
//   • Taxes: BUY 3% (team). SELL 15% = 12% wall + 3% team.
// Components read `core` / `d` / `series` / `feed`; exact on-chain values stay available in `market` (bigints).
// ===========================================================================

export const CONST = {
  TOTAL_SUPPLY: 21_000_000,
  BUY_TAX: 0.03, // buys: 3% → team
  SELL_TAX: 0.15, // sells: 15% total
  SELL_WALL_SHARE: 0.12, // of a sale: 12% → wall placed under the market
  SELL_TEAM_SHARE: 0.03, // of a sale: 3% → team
  BAND_SUPPLY: 16_800_000, // 80% of supply — the Band, placed once, never withdrawn
  VAULT_GENESIS_RESERVE: 4_200_000, // 20% of supply seeds the Vault reward reserve
  WALL_MARKET_WEIGHT: 0.4, // wall target = 0.4·market + 0.6·launch
  WALL_LAUNCH_WEIGHT: 0.6,
  WALL_UNDER_MARKET: 0.01, // at or below launch: 1% under the price
} as const;

// Launch pool price, ETH per CUBIT, from the deployed hook's initial sqrt price.
export const LAUNCH_PRICE_ETH = wadToNumber(sqrtPriceToWadPrice(CONFIG.launchSqrtPriceX96));

const POLL_MS = 8_000;
const WAITING_POLL_MS = 30_000;
const FEED_ROWS = 60;
const ETHEREUM_BLOCK_MS = 12_000;

// ===========================================================================
// TYPES
// ===========================================================================

export type EventKind = "WALL_PLACED" | "ABSORPTION" | "BUY" | "SELL" | "DELIVERED" | "BAND" | "TEAM";
export type WallStatus = "active" | "partial" | "crossed";

export type Wall = {
  id: string;
  wallId: number;
  lower: number; // pool tick of the wall's range — never moves
  level: number; // ETH per CUBIT at the top of the wall's range
  ethRemaining: number; // ETH the wall still holds
  cubitHeld: number; // CUBIT the wall bought while the price sits inside it
  fundedETH: number; // fresh ETH ever deployed at this tick
  status: WallStatus;
};

export type ProtocolEvent = {
  id: string;
  kind: EventKind;
  headline: string;
  detail: string;
  block: number;
  tx: string;
  ts: number;
};

export type Core = {
  walls: Wall[]; // standing walls (highest level first), then crossed walls
  pendingWallETH: number; // wall funds not placed yet
  pendingAbsorbed: number; // crossed-wall CUBIT waiting in the hook for delivery
  absorbedToVault: number; // cumulative CUBIT taken out of crossed walls
  deliveredToVault: number; // cumulative CUBIT handed to the Vault reward reserve
  bandCubit: number;
  bandETH: number;
  marketPriceETH: number;
  priceUnavailable: boolean;
  launchPriceETH: number;
  teamAccountingETH: number; // team taxes accrued in the hook, not yet paid out
  teamPaidETH: number;
  rewardReserve: number; // every registered vault's reserve (Lens)
  circulatingSupply: number; // Lens: supply − wall CUBIT − reward reserves
  heldSupply: number; // Lens: circulating − the Band's unsold CUBIT
  totalSupply: number;
  vaultStaked: number;
  vaultPaid: number;
  nextWall: { level: number; underMarket: boolean } | null;
  block: number;
  timestamp: number;
};

export type Snapshot = SeriesPoint;

export type Derived = {
  circulatingSupply: number;
  launchPoolPriceETH: number;
  marketFDVETH: number;
  priceVsLaunch: number; // market / launch
  activeWalls: number; // standing walls: active + partially consumed
  partialWalls: number;
  crossedWalls: number;
  ethInWalls: number;
  topWallLevel: number; // highest standing wall = the first support a sale meets
  vaultReserve: number;
};

export type WalletStatus = "disconnected" | "connecting" | "connected";

export type Features = { vault: boolean; momentum: boolean; forge: boolean; flags: number };

export type ProtocolState = {
  core: Core;
  d: Derived;
  series: Snapshot[];
  feed: ProtocolEvent[];
  market: MarketState | null;
  /** Null until the pool state is read successfully; a failed read never means closed. */
  marketOpen: boolean | null;
  history: MarketHistory;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  features: Features;
  modules: { vault: Address; router: Address; lens: Address; forge: Address; revision: bigint } | null;
  wallet: WalletStatus;
  address: Address | null;
  addressLabel: string | null;
  chainId: number | null;
  wrongNetwork: boolean;
  walletError: string | null;
  wallets: WalletInfo[];
  connect: (uuid?: string) => void;
  disconnect: () => void;
  switchNetwork: () => void;
  refresh: () => void;
};

// ===========================================================================
// DERIVATION — pure
// ===========================================================================

const EMPTY_CORE: Core = {
  walls: [], pendingWallETH: 0, pendingAbsorbed: 0, absorbedToVault: 0, deliveredToVault: 0,
  bandCubit: 0, bandETH: 0, marketPriceETH: 0, priceUnavailable: true, launchPriceETH: LAUNCH_PRICE_ETH,
  teamAccountingETH: 0, teamPaidETH: 0, rewardReserve: 0, circulatingSupply: 0, heldSupply: 0,
  totalSupply: CONST.TOTAL_SUPPLY, vaultStaked: 0, vaultPaid: 0, nextWall: null, block: 0, timestamp: 0,
};

export function toWall(w: WallState): Wall {
  return {
    id: `wall-${w.id}`, wallId: w.id, lower: w.lower, level: wadToNumber(w.priceWad), ethRemaining: weiToEth(w.eth),
    cubitHeld: tokensToNumber(w.cubit), fundedETH: weiToEth(w.fundedEth), status: w.status,
  };
}

/** Standing walls by level (highest first), then crossed walls, newest first. */
export function sortWalls(walls: Wall[]): Wall[] {
  const standing = walls.filter((w) => w.status !== "crossed").sort((a, b) => b.level - a.level);
  const crossed = walls.filter((w) => w.status === "crossed").sort((a, b) => b.wallId - a.wallId);
  return [...standing, ...crossed];
}

export function toCore(m: MarketState | null, history: MarketHistory): Core {
  if (!m) return EMPTY_CORE;
  const sum = (kind: EventKind) => history.events.filter((e) => e.kind === kind).reduce((a, e) => a + (e.cubit ?? 0n), 0n);
  return {
    walls: sortWalls(m.walls.map(toWall)),
    pendingWallETH: weiToEth(m.pendingFloorEth),
    pendingAbsorbed: tokensToNumber(m.pendingAbsorbedTokens),
    absorbedToVault: tokensToNumber(sum("ABSORPTION")),
    deliveredToVault: tokensToNumber(sum("DELIVERED")),
    bandCubit: tokensToNumber(m.band.cubit),
    bandETH: weiToEth(m.band.eth),
    marketPriceETH: m.priceUnavailable ? 0 : wadToNumber(m.priceWad),
    priceUnavailable: m.priceUnavailable,
    launchPriceETH: wadToNumber(m.launchPriceWad),
    teamAccountingETH: weiToEth(m.teamAccrued),
    teamPaidETH: weiToEth(m.teamPaidCumulative),
    rewardReserve: tokensToNumber(m.lens?.rewardReserve ?? 0n),
    circulatingSupply: tokensToNumber(m.lens?.circulatingSupply ?? 0n),
    heldSupply: tokensToNumber(m.lens?.heldSupply ?? 0n),
    totalSupply: tokensToNumber(m.totalSupply),
    vaultStaked: tokensToNumber(m.vault?.totalStaked ?? 0n),
    vaultPaid: tokensToNumber(m.vault?.totalPaid ?? 0n),
    nextWall: m.nextWall ? { level: wadToNumber(m.nextWall.priceWad), underMarket: m.nextWall.underMarket } : null,
    block: Number(m.block),
    timestamp: m.timestamp,
  };
}

export function derive(c: Core, m: MarketState | null): Derived {
  return {
    circulatingSupply: c.circulatingSupply,
    launchPoolPriceETH: c.launchPriceETH,
    marketFDVETH: c.marketPriceETH * c.totalSupply,
    priceVsLaunch: c.launchPriceETH > 0 ? c.marketPriceETH / c.launchPriceETH : 0,
    activeWalls: m ? m.activeWalls + m.partialWalls : 0,
    partialWalls: m?.partialWalls ?? 0,
    crossedWalls: m?.crossedWalls ?? 0,
    ethInWalls: m ? weiToEth(m.wallEth) : 0,
    topWallLevel: m?.nearestWall ? wadToNumber(m.nearestWall.priceWad) : 0,
    vaultReserve: c.rewardReserve,
  };
}

/** Feed rows, newest first. A wall funded while standing thickens; otherwise it is placed (again, after a crossing). */
export function toFeed(events: MarketEvent[], symbol: string, times: Map<number, number>, head: { block: number; ts: number } | null): ProtocolEvent[] {
  const standing = new Set<number>();
  const rows: ProtocolEvent[] = [];
  const ts = (block: number) => times.get(block) ?? (head ? head.ts - (head.block - block) * ETHEREUM_BLOCK_MS : 0);
  for (const e of events) {
    const base = { id: e.id, kind: e.kind, block: e.block, tx: e.tx, ts: ts(e.block) };
    const eth = (wei?: bigint) => fmtEthAmount(weiToEth(wei ?? 0n));
    switch (e.kind) {
      case "BUY":
        rows.push({ ...base, headline: "BUY", detail: `${eth(e.ethWei)} ETH in · ${eth(e.toTeamWei)} ETH → team (3%)` });
        break;
      case "SELL":
        rows.push({ ...base, headline: "SELL", detail: `${eth(e.ethWei)} ETH gross · ${eth(e.toWallsWei)} ETH → wall · ${eth(e.toTeamWei)} ETH team` });
        break;
      case "WALL_PLACED": {
        const thickened = standing.has(e.wallId!);
        standing.add(e.wallId!);
        const level = wadToNumber(sqrtPriceToWadPrice(sqrtPriceAtTick(e.lower!)));
        rows.push({ ...base, headline: thickened ? "WALL THICKENED" : "WALL PLACED", detail: `wall #${e.wallId} · +${eth(e.ethWei)} ETH at ${fmtEth(level)}` });
        break;
      }
      case "ABSORPTION":
        standing.delete(e.wallId!);
        rows.push({ ...base, headline: "WALL CROSSED", detail: `wall #${e.wallId} emptied · ${fmtInt(tokensToNumber(e.cubit ?? 0n))} ${symbol} absorbed · ${eth(e.ethWei)} ETH → pending` });
        break;
      case "DELIVERED":
        rows.push({ ...base, headline: "DELIVERED", detail: `${fmtInt(tokensToNumber(e.cubit ?? 0n))} ${symbol} → ${symbol === "CUBIT" ? "Vault reward reserve" : "governance vault"}` });
        break;
      case "BAND":
        rows.push({ ...base, headline: "BAND PLACED", detail: `${fmtInt(tokensToNumber(e.cubit ?? 0n))} ${symbol} in one band, placed once` });
        break;
      case "TEAM":
        rows.push({ ...base, headline: "TEAM PAID", detail: `${eth(e.ethWei)} ETH → team address` });
        break;
    }
  }
  return rows.reverse();
}

// ===========================================================================
// HOOK — one live instance, owned by Root
// ===========================================================================

export function useProtocolStore(showHistory = true): ProtocolState {
  const wallet = useWallet();
  const [intervalMs, setIntervalMs] = useState(WAITING_POLL_MS);
  const historyReader = useMemo(() => publicData.history(CUBIT), []);
  const blockTimes = useMemo(() => createBlockTimes(), []);
  const poll = usePoll(async (block) => {
    const view = await publicData.protocol(block, showHistory);
    // Closed markets still expose the registry, but have no Lens snapshot, history or quote to read.
    const history = showHistory && view.marketOpen ? await historyReader(block) : emptyHistory();
    const shared = publicData.snapshot(block);
    const times = shared ? new Map(Object.entries(shared.eventTimes).map(([number, time]) => [Number(number), time]))
      : await blockTimes(publicData.context(block), history.events.slice(-FEED_ROWS));
    return { ...view, history, times, updatedAt: shared?.producedAt ?? Date.now() };
  }, [showHistory], intervalMs);
  useEffect(() => {
    if (poll.data) setIntervalMs(poll.data.marketOpen ? POLL_MS : WAITING_POLL_MS);
    else if (poll.error) setIntervalMs(WAITING_POLL_MS);
  }, [poll.data, poll.error]);
  const market = poll.data?.market ?? null;
  const history = poll.data?.history ?? emptyHistory();
  const times = poll.data?.times ?? new Map<number, number>();
  const error = poll.error;
  const updatedAt = poll.data?.updatedAt ?? null;
  useEffect(() => { startWalletDiscovery(); }, []);

  const core = useMemo(() => toCore(market, history), [market, history]);
  const d = useMemo(() => ({ ...derive(core, market), ethInWalls: weiToEth(poll.data?.wallEth ?? 0n) }), [core, market, poll.data?.wallEth]);
  const series = useMemo(() => {
    const points = buildSeries(history, market);
    if (!market) return points;
    const head = { block: Number(market.block), ts: market.timestamp * 1000 };
    return points.map((p) => ({ ...p, ts: p.ts ?? head.ts - (head.block - p.block) * ETHEREUM_BLOCK_MS }));
  }, [history, market]);
  const feed = useMemo(
    () => toFeed(history.events, "CUBIT", times, market ? { block: Number(market.block), ts: market.timestamp * 1000 } : null).slice(0, FEED_ROWS),
    [history, times, market],
  );
  const registry = poll.data?.registry ?? null;
  const flags = registry?.flags ?? 0;
  const forgeRegistered = !!registry && !/^0x0{40}$/i.test(registry.forge);

  const connect = useCallback((uuid?: string) => void connectWallet(uuid), []);
  const disconnect = useCallback(() => disconnectWallet(), []);
  const switchNetwork = useCallback(() => void switchToAppChain().catch(() => undefined), []);
  const refresh = useCallback(() => { void poll.refresh(); }, [poll.refresh]);

  return {
    core,
    d,
    series,
    feed,
    market,
    marketOpen: poll.data?.marketOpen ?? null,
    history,
    loading: poll.data === null && error === null,
    error,
    updatedAt,
    features: { vault: (flags & 1) !== 0, momentum: (flags & 4) !== 0, forge: (flags & 8) !== 0 && forgeRegistered, flags },
    modules: registry ? { vault: registry.vault, router: registry.router, lens: registry.lens, forge: registry.forge, revision: registry.moduleRevision } : null,
    wallet: wallet.status,
    address: wallet.address,
    addressLabel: wallet.address ? shortAddress(wallet.address) : null,
    chainId: wallet.chainId,
    wrongNetwork: wallet.status === "connected" && wallet.chainId !== CONFIG.chainId,
    walletError: wallet.error,
    wallets: wallet.wallets,
    connect,
    disconnect,
    switchNetwork,
    refresh,
  };
}
