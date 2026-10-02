export class TransactionCancelled extends Error {
  constructor() { super("Transaction sequence cancelled."); }
}

export type TxStep<T> = { label: string; request: (check: () => void) => Promise<T | null> };

/** Preparation may await RPC or salt mining; check again before handing anything to a signer. */
export async function runTxSteps<T>(
  steps: TxStep<T>[], check: () => void, send: (request: T) => Promise<unknown>, onStep: (label: string) => void,
): Promise<void> {
  check();
  for (const step of steps) {
    check();
    onStep(step.label);
    const request = await step.request(check);
    check();
    if (request) { await send(request); check(); }
  }
  check();
}

/** A transaction that is slow to be included is not a failure. At this point the caller asks the user whether to
 *  keep waiting or start over, instead of abandoning the wait and calling a live transaction failed: a launch fee,
 *  once paid, is never refunded, so a re-send must be a decision, never the consequence of a deadline of our own. */
export const SLOW_RECEIPT_MS = 240_000;

export async function waitForInclusion<T>(wait: () => Promise<T>, onSlow?: () => void, slowMs = SLOW_RECEIPT_MS): Promise<T> {
  const timer = setTimeout(() => onSlow?.(), slowMs);
  try { return await wait(); } finally { clearTimeout(timer); }
}

export type ReplacementReason = "cancelled" | "replaced" | "repriced";

/** Why a replaced transaction must stop a sequence, or null when the replacement is the same transaction. */
export function replacementFailure(reason: ReplacementReason | null): string | null {
  if (reason === "cancelled") return "The transaction was cancelled in the wallet.";
  if (reason === "replaced") return "The wallet replaced this transaction with a different one.";
  return null;
}
