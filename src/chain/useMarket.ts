import { useMemo } from "react";
import { publicData } from "./appChain";
import { emptyHistory } from "./events";
import { type MarketRef } from "./market";
import { usePoll } from "./usePoll";

/** One market and its cursor, with exactly the same lifecycle guards as every other page poll. */
export function useMarket(ref: MarketRef | null, enabled = true, intervalMs = 10_000) {
  const historyReader = useMemo(() => ref ? publicData.history(ref) : null, [ref?.hook]);
  const poll = usePoll(async (block) => {
    const [market, history] = await Promise.all([publicData.market(ref!, block), historyReader!(block)]);
    return { market, history };
  }, [ref?.hook], intervalMs, !!ref && enabled);
  return { market: poll.data?.market ?? null, history: poll.data?.history ?? emptyHistory(), error: poll.error, refresh: poll.refresh };
}
