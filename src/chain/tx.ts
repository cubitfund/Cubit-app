// Every write goes through sendWrite: right network, a simulation that surfaces the revert reason, a gas limit with a
// margin (a node's estimate can sit below the limit a ReentrancyGuard refund needs), then the receipt.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
  type Hex, type TransactionReceipt,
} from "viem";
import { replacementFailure, runTxSteps, TransactionCancelled, waitForInclusion, type ReplacementReason, type TxStep } from "./txSequence";
import { chain, publicClient } from "./client";
import { CONFIG } from "./config";
import { getWalletClient, getWalletState, switchToAppChain, walletErrorMessage } from "./wallet";

import { TX_GAS_CAP, type WriteRequest } from "./writeRequest.ts";
export { TX_GAS_CAP, type WriteRequest } from "./writeRequest.ts";

export function errorMessage(error: unknown): string {
  if (error instanceof BaseError) {
    if (error.walk((cause) => cause instanceof UserRejectedRequestError)) return "Request rejected in the wallet.";
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (revert.reason) return `Reverted: ${revert.reason}`;
      if (name && name !== "Error") return `Reverted: ${name}${revert.data?.args?.length ? ` (${revert.data.args.map(String).join(", ")})` : ""}`;
      return "The contract rejected this transaction.";
    }
    return error.shortMessage;
  }
  return walletErrorMessage(error);
}

/** Simulate, estimate with a margin, sign, wait. Throws a readable message. `afterBlock` is the block of the step
 *  mined just before: the shared data relay answers from a snapshot that can be ~30 s old, so a step that depends on
 *  it (a stake right after its approval) is simulated at that block, which the relay hands to the direct RPC. */
export async function sendWrite(
  request: WriteRequest, onHash?: (hash: Hex) => void, check: () => void = () => {}, onSlow?: () => void,
  afterBlock?: bigint,
): Promise<TransactionReceipt> {
  check();
  const wallet = getWalletClient();
  const account = getWalletState().address;
  if (!wallet || !account) throw new Error("Connect a wallet first.");
  const provider = getWalletState().current?.uuid;
  const assertReady = () => {
    check();
    const live = getWalletState();
    if (live.address !== account || live.current?.uuid !== provider || live.chainId !== CONFIG.chainId) throw new TransactionCancelled();
  };
  if (getWalletState().chainId !== CONFIG.chainId) { await switchToAppChain(); check(); }
  assertReady();
  const call = { ...request, account, ...(afterBlock === undefined ? {} : { blockNumber: afterBlock }) } as Parameters<typeof publicClient.simulateContract>[0];
  await publicClient.simulateContract(call);
  assertReady();
  const estimate = await publicClient.estimateContractGas(call as Parameters<typeof publicClient.estimateContractGas>[0]);
  assertReady();
  const padded = (estimate * 125n) / 100n + 30_000n;
  if (estimate > TX_GAS_CAP) throw new Error("This transaction needs more gas than one transaction allows. Split it.");
  const hash = await wallet.writeContract({
    ...(request as object),
    account,
    chain,
    gas: padded > TX_GAS_CAP ? TX_GAS_CAP : padded,
  } as unknown as Parameters<typeof wallet.writeContract>[0]);
  // A submitted transaction still gets its receipt even if the UI was unmounted during signing.
  onHash?.(hash);
  // No deadline of our own: a transaction waiting for a slow block or a low priority fee is still alive, and
  // calling it failed invites a second send. viem resolves with the receipt of a wallet's speed-up too.
  let replaced: ReplacementReason | null = null;
  const receipt = await waitForInclusion(
    () => publicClient.waitForTransactionReceipt({ hash, timeout: 0, onReplaced: (r) => { replaced = r.reason; } }), onSlow,
  );
  check();
  // A speed-up ("repriced") is the same transaction; a cancellation or a different transaction in its place is not,
  // and the steps after it must not run as if it had gone through.
  const failure = replacementFailure(replaced);
  if (failure) throw new Error(failure);
  if (receipt.status !== "success") throw new Error("The transaction reverted on chain.");
  return receipt;
}

export type TxPhase = "idle" | "working" | "signing" | "pending" | "success" | "error";

/** One action button's transaction state. `run` executes steps in order, each step signing one transaction.
 *  `onDone` receives the last receipt on success, no receipt on failure or when every step was skipped. */
export function useTx(onDone?: (receipt?: TransactionReceipt) => void) {
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [label, setLabel] = useState<string | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The transaction is taking long enough that the UI must say so rather than let the user re-send. */
  const [slow, setSlow] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true; // StrictMode runs setup again after its development cleanup.
    return () => { mounted.current = false; generation.current++; busy.current = false; clearTimeout(timer.current); };
  }, []);

  const run = useCallback(async (steps: TxStep<WriteRequest>[]) => {
    if (busy.current || !mounted.current) return false;
    const started = generation.current;
    const identity = getWalletState();
    const live = () => mounted.current && started === generation.current;
    const check = () => {
      const wallet = getWalletState();
      if (!live() || identity.address !== wallet.address || identity.current?.uuid !== wallet.current?.uuid) throw new TransactionCancelled();
    };
    busy.current = true;
    clearTimeout(timer.current);
    setError(null);
    setHash(null);
    setSlow(false);
    try {
      let receipt: TransactionReceipt | undefined;
      await runTxSteps(steps, check, async (request) => {
        setPhase("signing");
        receipt = await sendWrite(request, (h) => {
          if (!live()) return;
          setHash(h);
          setPhase("pending");
        }, check, () => { if (live()) setSlow(true); }, receipt?.blockNumber);
      }, (label) => { setPhase("working"); setLabel(label); });
      check();
      if (live()) setPhase("success");
      onDone?.(receipt);
      return true;
    } catch (e) {
      if (live()) {
        setPhase("error");
        setError(errorMessage(e));
      }
      if (live()) onDone?.();
      return false;
    } finally {
      if (live()) setSlow(false);
      if (live()) busy.current = false;
      if (live()) timer.current = setTimeout(() => { setPhase((p) => (p === "success" ? "idle" : p)); setLabel(null); }, 6_000);
    }
  }, [onDone]);

  const reset = useCallback(() => { setPhase("idle"); setError(null); setHash(null); setLabel(null); setSlow(false); }, []);

  /** Stop following a transaction that is still in flight and give the form back. The transaction stays alive on
   *  chain — its hash is kept on screen — and nothing here can hurry it, so the user must not stay locked behind
   *  it. Sending again is what the caller's own guard has to make harmless. */
  const stopWaiting = useCallback(() => {
    if (!busy.current) return;
    generation.current++;
    busy.current = false;
    clearTimeout(timer.current);
    setPhase("idle");
    setLabel(null);
    setSlow(false);
    setError(null);
  }, []);

  return {
    run, phase, label, hash, error, slow, reset, stopWaiting,
    busy: phase === "working" || phase === "signing" || phase === "pending",
  };
}
