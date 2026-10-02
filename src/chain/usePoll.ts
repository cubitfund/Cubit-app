import { useCallback, useEffect, useRef, useState } from "react";
import { blockClock, assertAppBlock } from "./appChain";
import { BlockChangedError, type BlockSnapshot } from "./readContext";
import { PollTask } from "./pollTask";
import { errorMessage } from "./tx";
import { onTabVisible, tabHidden } from "./visibility";

/** Each consumer keeps its cadence and only reads a new block. Initial/dependency loads, explicit refreshes and
 *  visibility resumes may reread the current block. Cleanup invalidates results and queued work. */
export function usePoll<T>(load: (block: BlockSnapshot) => Promise<T>, deps: readonly unknown[], intervalMs = 10_000, enabled = true, keep = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const loader = useRef(load);
  loader.current = load;
  const task = useRef<PollTask<T> | null>(null);
  const active = useRef(enabled);
  active.current = enabled;
  // Mask previous identity's data immediately, including the render before the effect cleanup.
  const identity = useRef(deps);
  const changed = deps.length !== identity.current.length || deps.some((value, i) => value !== identity.current[i]);

  useEffect(() => {
    identity.current = deps;
    if (!keep) { setData(null); setError(null); }
    setLoading(enabled);
    if (!enabled) return;
    const poll = new PollTask<T>({
      clock: blockClock, interval: intervalMs, allowed: () => active.current && !tabHidden(),
      load: async (block) => {
        const value = await loader.current(block);
        await assertAppBlock(block);
        return value;
      },
      publish: (value) => { setData(value); setError(null); setLoading(false); },
      // Only a lost provenance check invalidates the displayed value: those figures belong to a branch the
      // provider can no longer validate. Any other failure is a read that did not happen, so the last known
      // figures stay on screen with their own timestamp rather than emptying the page.
      error: (e) => {
        if (e instanceof BlockChangedError) setData(null);
        setError(errorMessage(e)); setLoading(false);
      },
    });
    task.current = poll;
    poll.start();
    const stop = onTabVisible(() => void poll.refresh());
    return () => { poll.stop(); stop(); if (task.current === poll) task.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, intervalMs]);

  const refresh = useCallback(() => task.current?.refresh(), []);
  return { data: changed && !keep ? null : data, error: changed && !keep ? null : error, loading, refresh };
}
