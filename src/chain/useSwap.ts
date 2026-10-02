import { publicData } from "./appChain";
import type { BlockSnapshot } from "./readContext";
import { useRelayAccess } from "./useRelayAccess";
// The swap panel's state machine for any market: a debounced quote refreshed every 12 s, balances, and the steps a
// trade needs. CUBIT sells approve the registry's router; child sells approve Permit2 once, then give the Universal
// Router a one-hour Permit2 allowance for the amount.
import { useCallback, useEffect, useState, useRef } from "react";
import { maxUint256, zeroAddress, type Address } from "viem";
import { publicClient } from "./client";
import { CONFIG } from "./config";
import type { MarketRef } from "./market";
import { minOut, parseSlippage, parseUnitsDec } from "./math";
import { bestEthRoute } from "./ethRoute";
import type { V3Path } from "./swapEncoding";
import {
  approveRequest, chainDeadline, permit2Allowance, permit2ApproveRequest, quoteExactIn, routerSwapRequest,
  permit2TokenApproveRequest, saleFitsOneTransaction, SALE_TOO_LARGE, tokenAllowance, tokenBalance, universalRouterEthBuyRequest, universalRouterSwapRequest,
} from "./swap";
import { useTx, type WriteRequest } from "./tx";
import { usePoll } from "./usePoll";
import { RequestSequence } from "./requestSequence";
import type { TxStep } from "./txSequence";
import { useWallet } from "./wallet";

export type SwapMode = "buy" | "sell";

const QUOTE_TTL_MS = 30_000;

/** `route` and `pairIn` are set when a buy pays an ERC-20 pair with ETH: the v3 path, and the pair it yields. */
type QuoteState = { key: string; request: number; out: bigint; gas: bigint; at: number; block: BlockSnapshot; route?: V3Path; pairIn?: bigint };

export function useSwap({ market, router, mode, amount, slippage, payEth = false, enabled = true, onDone }: {
  market: MarketRef;
  /** The registry's router for CUBIT; ignored for launchpad children. */
  router: Address | null;
  mode: SwapMode;
  amount: string;
  slippage: string;
  /** Buy a launchpad v2 child whose pair is an ERC-20 with ETH, routed through Uniswap v3 to the pair (ethRoute.ts). */
  payEth?: boolean;
  enabled?: boolean;
  onDone?: () => void;
}) {
  useRelayAccess(enabled);
  const wallet = useWallet();
  const account = wallet.status === "connected" ? wallet.address : null;
  // A buy spends the pool's quote (ETH, or a launchpad v2 child's ERC-20 with its own decimals); a sale, the token.
  const quoteToken = market.quote?.address ?? zeroAddress;
  const viaEth = payEth && mode === "buy" && !market.parent && quoteToken !== zeroAddress;
  const units = parseUnitsDec(amount, mode === "buy" && !viaEth ? (market.quote?.decimals ?? 18) : 18);
  const slippagePct = parseSlippage(slippage);
  const key = `${CONFIG.chainId}:${wallet.chainId}:${market.token}:${market.hook}:${mode}:${viaEth}:${units}:${enabled}`;
  const balanceKey = `${account}:${market.token}:${CONFIG.chainId}:${wallet.chainId}`;
  const [debouncedKey, setDebouncedKey] = useState("");
  const requests = useRef(new RequestSequence());
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(Date.now());
  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    onDone?.();
  }, [onDone]);
  const tx = useTx(bump);

  useEffect(() => {
    requests.current.invalidate();
    const timer = setTimeout(() => setDebouncedKey(key), 350);
    return () => { clearTimeout(timer); requests.current.invalidate(); };
  }, [key]);
  const quotes = usePoll<QuoteState>(async (block) => {
    if (!publicData.fresh(block)) throw new Error("Snapshot is stale; wait for fresh market data.");
    const request = requests.current.begin();
    const at = Date.now();
    if (viaEth) {
      const route = await bestEthRoute(publicClient as never, CONFIG, quoteToken, units, block.number);
      if (!route) throw new Error(`no Uniswap route from ETH to ${market.quote?.symbol ?? "this pair"}`);
      const q = await quoteExactIn(market, true, route.out, block.number);
      return { key, request, out: q.out, gas: q.gas + route.gas, at, block, route: route.path, pairIn: route.out };
    }
    const q = await quoteExactIn(market, mode === "buy", units, block.number);
    return { key, request, out: q.out, gas: q.gas, at, block };
  }, [key, version], 12_000, enabled && units > 0n && debouncedKey === key);
  const balanceRead = usePoll(async (block) => {
    const [eth, token, quote] = await Promise.all([
      publicClient.getBalance({ address: account!, blockNumber: block.number }), tokenBalance(market.token, account!, block.number),
      quoteToken === zeroAddress ? Promise.resolve(null) : tokenBalance(quoteToken, account!, block.number),
    ]);
    return { key: balanceKey, eth, token, quote: quote ?? eth };
  }, [balanceKey, version], 12_000, enabled && !!account && wallet.chainId === CONFIG.chainId);
  const balances = balanceRead.data?.key === balanceKey ? balanceRead.data : null;
  const quote = enabled ? quotes.data : null;
  const quoteError = !enabled ? null : quotes.error ? `No quote: ${quotes.error}` : quote?.out === 0n ? "No output for this amount." : null;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const current = quote && quote.key === key && requests.current.current(quote.request) && now - quote.at < QUOTE_TTL_MS ? quote : null;
  const tooManyWalls = mode === "sell" && !!current && !saleFitsOneTransaction(current.gas);
  const insufficient = !!balances && units > 0n && (mode === "buy" ? units > (viaEth ? balances.eth : balances.quote) : units > balances.token);
  const routerMissing = market.parent && !router;
  const canSubmit = enabled && !!account && !!current && current.out > 0n && slippagePct !== null && !tooManyWalls && !!balances && !insufficient &&
    publicData.fresh(current.block, now) && !routerMissing && !tx.busy && wallet.chainId === CONFIG.chainId;

  const submit = useCallback(async () => {
    if (!canSubmit || !account || !current || slippagePct === null || Date.now() - current.at >= QUOTE_TTL_MS) return false;
    const buy = mode === "buy";
    const out = minOut(current.out, slippagePct);
    const steps: TxStep<WriteRequest>[] = [];
    if (!buy && market.parent && router) {
      steps.push({
        label: "Approve CUBIT",
        request: async () => ((await tokenAllowance(market.token, account, router)) >= units ? null : approveRequest(market.token, router, units)),
      });
    }
    // A child's sale pays its token, and a launchpad v2 buy with an ERC-20 quote pays that quote: both through Permit2.
    const paid = !market.parent && (!buy || (quoteToken !== zeroAddress && !viaEth)) ? (buy ? quoteToken : market.token) : null;
    const paidSymbol = buy ? (market.quote?.symbol ?? "ETH") : market.symbol;
    if (paid) {
      // USDT refuses to change a non-zero allowance: a short one is reset to zero first (harmless for other tokens).
      steps.push({
        label: `Reset the ${paidSymbol} allowance`,
        request: async () => {
          const current = await tokenAllowance(paid, account, CONFIG.permit2);
          return current > 0n && current < units ? permit2TokenApproveRequest(paid, 0n) : null;
        },
      });
      steps.push({
        label: `Approve ${paidSymbol} for Permit2`,
        request: async () => ((await tokenAllowance(paid, account, CONFIG.permit2)) >= units ? null : permit2TokenApproveRequest(paid, maxUint256)),
      });
      steps.push({
        label: "Permit2 allowance",
        request: async (check) => {
          const allowance = await permit2Allowance(account, paid);
          check();
          const chainTime = Number((await publicClient.getBlock({ blockTag: "latest" })).timestamp);
          check();
          return allowance.amount >= units && allowance.expiration > chainTime + 300 ? null : permit2ApproveRequest(paid, units, chainTime + 3_600);
        },
      });
    }
    steps.push({
      label: buy ? `Buy ${market.symbol}` : `Sell ${market.symbol}`,
      request: async (check) => {
        const deadline = await chainDeadline();
        check();
        if (Date.now() - current.at >= QUOTE_TTL_MS) throw new Error("Quote expired. Please review a fresh quote.");
        if (viaEth) return universalRouterEthBuyRequest(market, current.route!, units, out, deadline);
        return market.parent
          ? routerSwapRequest(router!, market, buy, units, out, account, deadline)
          : universalRouterSwapRequest(market, buy, units, out, deadline);
      },
    });
    return tx.run(steps);
  }, [canSubmit, account, current, slippagePct, mode, market, router, units, tx, quoteToken, viaEth]);

  return {
    units,
    viaEth,
    quote: current,
    quoteError,
    balances,
    tooManyWalls,
    tooManyWallsMessage: SALE_TOO_LARGE,
    insufficient,
    routerMissing,
    slippageValid: slippagePct !== null,
    canSubmit,
    submit,
    tx,
    account,
    wrongNetwork: !!account && wallet.chainId !== CONFIG.chainId,
  };
}
