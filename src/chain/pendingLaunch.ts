// Launches the browser prepared but has not seen confirmed, kept across reloads, per chain and per launcher. A second
// attempt at the same token reuses its salts, so the child token's CREATE2 address is already taken and the second
// transaction reverts, costing only its gas, never a second fee. Without it, a launcher who believes a slow transaction failed pays the
// launch fee twice, and governance never refunds it.
import type { Address, Hex } from "viem";

export type PendingLaunch = {
  chainId: number;
  launcher: Address;
  name: string;
  symbol: string;
  team: Address;
  tokenSalt: Hex;
  /** Null until the hook salt has been mined for this token. */
  hookSalt: Hex | null;
  token: Address | null;
  hook: Address | null;
  /** Null until the wallet has returned a transaction hash. */
  hash: Hex | null;
  at: number;
};
export type LaunchIdentity = Pick<PendingLaunch, "chainId" | "launcher" | "name" | "symbol" | "team">;

/** Several launches may be in flight; keeping a few means a new one never erases another's guard. */
export const PENDING_LAUNCHES = 5;
export const pendingLaunchKey = (chainId: number, launcher: Address) =>
  `cubit:pending-launch:${chainId}:${launcher.toLowerCase()}`;

/** Storage is optional: a private window, a blocked origin or a full quota must never break a launch. */
export type LaunchStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const browserLaunchStore = (): LaunchStore | null => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

const isAddress = (value: unknown): value is Address => typeof value === "string" && /^0x[\da-fA-F]{40}$/.test(value);
const isWord = (value: unknown): value is Hex => typeof value === "string" && /^0x[\da-fA-F]{64}$/.test(value);
const optional = <T>(value: unknown, ok: (v: unknown) => v is T): { value: T | null } | null =>
  value === undefined || value === null ? { value: null } : ok(value) ? { value } : null;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const sameLaunch = (saved: PendingLaunch, want: LaunchIdentity) =>
  saved.chainId === want.chainId && same(saved.launcher, want.launcher) && same(saved.team, want.team) &&
  saved.name === want.name && saved.symbol === want.symbol;

/** Anything unreadable is dropped: a wrong salt would be worse than mining a new one. */
export function parsePendingLaunch(value: unknown): PendingLaunch | null {
  const raw = value as Partial<PendingLaunch> | null;
  if (!raw || typeof raw !== "object") return null;
  const hookSalt = optional(raw.hookSalt, isWord);
  const token = optional(raw.token, isAddress);
  const hook = optional(raw.hook, isAddress);
  const hash = optional(raw.hash, isWord);
  if (typeof raw.chainId !== "number" || !Number.isInteger(raw.chainId) || !isAddress(raw.launcher) ||
      !isAddress(raw.team) || typeof raw.name !== "string" || typeof raw.symbol !== "string" ||
      !isWord(raw.tokenSalt) || !hookSalt || !token || !hook || !hash ||
      typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
  return {
    chainId: raw.chainId, launcher: raw.launcher, name: raw.name, symbol: raw.symbol, team: raw.team,
    tokenSalt: raw.tokenSalt, hookSalt: hookSalt.value, token: token.value, hook: hook.value,
    hash: hash.value, at: raw.at,
  };
}

export function parsePendingLaunches(text: string | null, chainId: number, launcher: Address): PendingLaunch[] {
  if (!text) return [];
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const launches: PendingLaunch[] = [];
  for (const entry of raw.slice(0, PENDING_LAUNCHES)) {
    const launch = parsePendingLaunch(entry);
    // The key already says which chain and launcher: a row claiming another one is not this launcher's guard.
    if (launch && launch.chainId === chainId && same(launch.launcher, launcher)) launches.push(launch);
  }
  return launches;
}

export function readPendingLaunches(chainId: number, launcher: Address | null, store = browserLaunchStore()): PendingLaunch[] {
  if (!launcher) return [];
  let text: string | null = null;
  try { text = store?.getItem(pendingLaunchKey(chainId, launcher)) ?? null; } catch { return []; }
  return parsePendingLaunches(text, chainId, launcher);
}

function write(launches: PendingLaunch[], chainId: number, launcher: Address, store: LaunchStore | null) {
  const key = pendingLaunchKey(chainId, launcher);
  try {
    if (launches.length === 0) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(launches.slice(0, PENDING_LAUNCHES)));
  } catch { /* losing the guard beats failing the launch */ }
}

/** The newest attempt at a token replaces its own row and keeps the other launches waiting. */
export function savePendingLaunch(launch: PendingLaunch, store = browserLaunchStore()) {
  const others = readPendingLaunches(launch.chainId, launch.launcher, store).filter((p) => !sameLaunch(p, launch));
  write([launch, ...others], launch.chainId, launch.launcher, store);
}

export function clearPendingLaunch(identity: LaunchIdentity, store = browserLaunchStore()) {
  const kept = readPendingLaunches(identity.chainId, identity.launcher, store).filter((p) => !sameLaunch(p, identity));
  write(kept, identity.chainId, identity.launcher, store);
}

/** Record the hash as soon as the wallet returns it, so a reload can point at the transaction still in flight. */
export function recordLaunchHash(identity: LaunchIdentity, hash: Hex, store = browserLaunchStore(), now = Date.now()) {
  const saved = matchesLaunch(readPendingLaunches(identity.chainId, identity.launcher, store), identity);
  if (saved && saved.hash !== hash) savePendingLaunch({ ...saved, hash, at: now }, store);
}

/** The saved salts may only be reused for the very same token: any other input is a different launch. */
export function matchesLaunch(saved: readonly PendingLaunch[], want: LaunchIdentity): PendingLaunch | null {
  return saved.find((p) => sameLaunch(p, want)) ?? null;
}
