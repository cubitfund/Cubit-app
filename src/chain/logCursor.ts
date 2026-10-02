import { classifyRpcError } from "./rpcErrors.ts";
import type { BlockSnapshot } from "./readContext.ts";
import type { Hex } from "viem";

export const REORG_BLOCKS = 6n;
const CHUNK = 10_000n;
// Older cursors may pair an orphaned prefix with a canonical anchor. They cannot be repaired incrementally.
const CURSOR_VERSION = 2;

/** Inclusive chunks; a provider's size/range refusal recursively halves just that range. */
export async function chunked<T>(from: bigint, to: bigint, fetch: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
  const read = async (lo: bigint, hi: bigint): Promise<T[]> => {
    try { return await fetch(lo, hi); }
    catch (e) {
      if (lo === hi || classifyRpcError(e) !== "range") throw e;
      const mid = (lo + hi) / 2n;
      return [...await read(lo, mid), ...await read(mid + 1n, hi)];
    }
  };
  const out: T[] = [];
  for (let lo = from; lo <= to; lo += CHUNK) out.push(...await read(lo, lo + CHUNK - 1n < to ? lo + CHUNK - 1n : to));
  return out;
}

export type CursorStore = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};
export type CursorPersistence = { store: CursorStore; key: string };

export type CursorRow = { id: string; block: number | bigint; blockHash: Hex };
type CursorState<T> = {
  version: number;
  rows: T[];
  head: BlockSnapshot;
  anchor: { number: bigint; hash: Hex } | null;
};

/** The reread window REPLACES prior rows, including empty windows and a head that moved backwards. */
export function replaceWindow<T extends { id: string; block: number | bigint }>(old: T[], fresh: T[], from: bigint, to: bigint): T[] {
  const rows = new Map(old.filter((r) => BigInt(r.block) < from && BigInt(r.block) <= to).map((r) => [r.id, r]));
  for (const row of fresh) {
    if (BigInt(row.block) < from || BigInt(row.block) > to) throw new Error("Log outside the requested window.");
    rows.set(row.id, row);
  }
  return [...rows.values()];
}

/** In-memory cursor owned by a caller, serialized and committed only after successful reads and hash checks. */
export function createLogCursor<T extends CursorRow>(
  first: bigint, fetch: (from: bigint, to: bigint) => Promise<T[]>,
  hashAt: (block: bigint) => Promise<Hex>, persistence?: CursorPersistence,
) {
  let state: CursorState<T> | undefined;
  let restored = false;
  let tail: Promise<unknown> = Promise.resolve();
  const read = (block: BlockSnapshot): Promise<T[]> => {
    const job = tail.then(async () => {
      // Restoration is staged too: a failed validation must not change the live cursor.
      const saved = restored ? state : await persistence?.store.get<CursorState<T>>(persistence.key);
      const previous = saved?.version === CURSOR_VERSION ? saved : undefined;
      const { head, anchor } = previous ?? { head: null, anchor: null };
      let from = head ? head.number - REORG_BLOCKS + 1n : first;
      if (from < first) from = first;
      const prefixValid = !anchor || (anchor.number <= block.number && await hashAt(anchor.number) === anchor.hash);
      if (!prefixValid) from = first;
      if (head?.hash === block.hash && prefixValid) {
        if (await hashAt(block.number) !== block.hash) throw new Error("History head changed during the read.");
        state = previous;
        restored = true;
        return previous!.rows;
      }
      if (block.number < from) from = block.number < first ? first : block.number - REORG_BLOCKS + 1n;
      if (from < first) from = first;
      const fresh = await fetch(from, block.number);
      if (await hashAt(block.number) !== block.hash) throw new Error("History head changed during the read.");
      const anchorNumber = block.number - REORG_BLOCKS;
      const nextAnchor = anchorNumber >= first ? { number: anchorNumber, hash: await hashAt(anchorNumber) } : null;
      // Validate the retained prefix and head AFTER acquiring the new anchor. Nothing from this read is
      // committed until the whole tuple agrees, including when the reorg starts during the anchor lookup.
      if (anchor && from > first && await hashAt(anchor.number) !== anchor.hash)
        throw new Error("History prefix changed during the read.");
      if (await hashAt(block.number) !== block.hash) throw new Error("History head changed during the read.");
      const next: CursorState<T> = {
        version: CURSOR_VERSION, rows: replaceWindow(previous?.rows ?? [], fresh, from, block.number),
        head: block, anchor: nextAnchor,
      };
      await persistence?.store.put(persistence.key, next);
      state = next;
      restored = true;
      return next.rows;
    });
    tail = job.catch(() => undefined);
    return job;
  };
  return { read };
}
