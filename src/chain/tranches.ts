import type { Address } from "viem";
import { CubitGovernanceVaultAbi } from "./abi.ts";
import type { BlockSnapshot, ReadContext } from "./readContext.ts";

export const TRANCHE_ROWS = 40n;
/** Count actual getter calls, including probes and bounds, rather than the size of the book. */
export const GOVERNANCE_MAX_READS = 160;
export const GOVERNANCE_DETAIL_MS = 8_000;
export type Tranche = { index: bigint; amount: bigint; unlockAt: bigint };
export type GovernanceDetails = {
  locked: bigint;
  claimable: bigint;
  claimableTranches: bigint;
  /** An optional visible page. Only the matured prefix is summed. */
  tranches: Tranche[];
  nextLocked: Tranche | null;
  trancheCount: bigint;
  nextTranche: bigint;
  page: number;
};

export class GovernanceDetailError extends Error {}
const inconsistent = () => new GovernanceDetailError("Detail unavailable: inconsistent tranche data. Total held is shown.");
export const governanceDetailError = (error: unknown) => error instanceof GovernanceDetailError
  ? error.message : "Detail unavailable at this block. Total held is shown. Refresh the detail to retry.";

export async function readTranchePage(start: bigint, count: bigint, read: (index: bigint) => Promise<Tranche>): Promise<Tranche[]> {
  if (start < 0n || start > count) throw inconsistent();
  const length = Number(count - start < TRANCHE_ROWS ? count - start : TRANCHE_ROWS);
  const rows = await Promise.all(Array.from({ length }, async (_, i) => read(start + BigInt(i))));
  if (rows.some((row, i) => row.index !== start + BigInt(i) || row.amount <= 0n || row.unlockAt < 0n)) throw inconsistent();
  return rows;
}

/** One immutable block, no cross-block row cache. Locate the maturity boundary, then sum only
 * the matured prefix. The two extreme cases follow from the vault's accounting/order invariants.
 * A request or time budget failure discards all detail; it never returns a partial sum.
 */
export async function readGovernanceDetails(
  { client }: Pick<ReadContext, "client">, vault: Address, token: Address, held: bigint, block: BlockSnapshot,
  requestedPage: number | null = null, signal?: AbortSignal,
): Promise<GovernanceDetails> {
  const deadline = Date.now() + GOVERNANCE_DETAIL_MS;
  let stopped = false, calls = 0;
  const timeout = new GovernanceDetailError("Detail unavailable: the read took too long. Total held is shown. Refresh the detail to retry.");
  const cancelled = new GovernanceDetailError("Detail unavailable: request cancelled. Total held is shown.");
  const budget = new GovernanceDetailError("Detail unavailable: read budget reached. Total held is shown.");
  const prefixBudget = new GovernanceDetailError("Detail unavailable: too many matured tranches to total within the read budget. Total held is shown. Claim matured tranches in batches of 64, then refresh the detail.");
  const check = () => {
    if (signal?.aborted) throw cancelled;
    if (stopped || Date.now() >= deadline) throw timeout;
  };
  const reserve = (number = 1) => { check(); if (calls + number > GOVERNANCE_MAX_READS) throw budget; calls += number; };
  const at = { address: vault, abi: CubitGovernanceVaultAbi, blockHash: block.hash, requireCanonical: true } as const;
  const bounds = () => {
    reserve(2);
    return Promise.all([
      client.readContract({ ...at, functionName: "trancheCount", args: [token] }),
      client.readContract({ ...at, functionName: "nextTranche", args: [token] }),
    ]);
  };
  const cache = new Map<bigint, Promise<Tranche>>();
  const observed = new Map<bigint, Tranche>();
  let observedAmount = 0n;
  const read = (index: bigint, verify = false): Promise<Tranche> => {
    check();
    const cached = cache.get(index);
    if (cached && !verify) return cached;
    reserve();
    const pending = client.readContract({ ...at, functionName: "tranche", args: [token, index] }).then(([amount, unlockAt]) => {
      check();
      if (amount <= 0n || unlockAt < 0n) throw inconsistent();
      for (const row of observed.values()) {
        if (row.index === index && (row.amount !== amount || row.unlockAt !== unlockAt) ||
            row.index < index && row.unlockAt > unlockAt || row.index > index && row.unlockAt < unlockAt) throw inconsistent();
      }
      if (!observed.has(index)) observedAmount += amount;
      if (observedAmount > held) throw inconsistent();
      const row = { index, amount, unlockAt };
      observed.set(index, row);
      return row;
    });
    cache.set(index, pending);
    return pending;
  };
  const load = async (): Promise<GovernanceDetails> => {
    check();
    const [count, next] = await bounds();
    check();
    if (next < 0n || count < next || held < 0n || (count === next) !== (held === 0n)) throw inconsistent();
    const checkBounds = async () => {
      check();
      const [currentCount, currentNext] = await bounds();
      check();
      if (currentCount !== count || currentNext !== next) throw inconsistent();
    };
    let boundary = next, claimable = 0n;
    let nextLocked: Tranche | null = null;
    if (next < count) {
      const first = await read(next);
      if (first.unlockAt > block.timestamp) nextLocked = first;
      else {
        const last = await read(count - 1n);
        if (last.unlockAt <= block.timestamp) { boundary = count; claimable = held; }
        else {
          let lo = next, hi = count - 1n; // known mature / known locked
          while (hi - lo > 1n) {
            const mid = lo + (hi - lo) / 2n;
            if ((await read(mid)).unlockAt <= block.timestamp) lo = mid;
            else hi = mid;
          }
          boundary = hi;
          // Fresh checks on BOTH sides also reject a provider changing an already returned row.
          const [before, after] = await Promise.all([boundary - 1n, boundary].map(async (index) => read(index, true)));
          if (before.unlockAt > block.timestamp || after.unlockAt <= block.timestamp) throw inconsistent();
          nextLocked = after;
          const matured = boundary - next;
          const cachedPrefix = BigInt([...observed.keys()].filter((i) => i >= next && i < boundary).length);
          // Reject a known unaffordable prefix before wasting calls on partial sums. This is a lower
          // bound on the remaining real calls (cache hits cost zero), not a cap on total tranches.
          const remaining = matured - cachedPrefix + 2n * ((matured + TRANCHE_ROWS - 1n) / TRANCHE_ROWS) + 2n;
          if (remaining > BigInt(GOVERNANCE_MAX_READS - calls)) throw prefixBudget;
          for (let start = next; start < boundary;) {
            const rows = await readTranchePage(start, boundary, read);
            check();
            const end = start + TRANCHE_ROWS < boundary ? start + TRANCHE_ROWS : boundary;
            const following = rows.length ? rows[rows.length - 1].index + 1n : start;
            if (following !== end || following <= start || BigInt(rows.length) !== end - start) throw inconsistent();
            for (const row of rows) {
              if (row.unlockAt > block.timestamp) throw inconsistent();
              claimable += row.amount;
            }
            if (claimable > held) throw inconsistent();
            await checkBounds();
            start = following;
          }
        }
      }
    }
    const maxPage = count > next ? (count - next - 1n) / TRANCHE_ROWS : 0n;
    const wanted = requestedPage !== null && Number.isSafeInteger(requestedPage) && requestedPage > 0 ? BigInt(requestedPage) : 0n;
    const page = Number(wanted < maxPage ? wanted : maxPage);
    const tranches = requestedPage === null ? [] : await readTranchePage(next + BigInt(page) * TRANCHE_ROWS, count, read);
    await checkBounds();
    if (claimable > held) throw inconsistent();
    return { locked: held - claimable, claimable, claimableTranches: boundary - next, nextLocked,
      tranches, trancheCount: count, nextTranche: next, page };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([load(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stopped = true; reject(timeout); }, GOVERNANCE_DETAIL_MS);
      onAbort = () => reject(cancelled);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
