// Browser wallets through EIP-6963 discovery, with window.ethereum as the fallback. No wallet SDK: a small external
// store React reads with useSyncExternalStore. A wallet connected once reconnects silently (eth_accounts) on reload.
import { useSyncExternalStore } from "react";
import { createWalletClient, custom, getAddress, numberToHex, type Address, type EIP1193Provider } from "viem";
import { chain } from "./client";
import { CONFIG } from "./config";

export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
type Detail = { info: WalletInfo; provider: EIP1193Provider };

export type WalletState = {
  status: "disconnected" | "connecting" | "connected";
  address: Address | null;
  chainId: number | null;
  wallets: WalletInfo[];
  current: WalletInfo | null;
  error: string | null;
};

const STORAGE_KEY = "cubit.wallet";
const details = new Map<string, Detail>();
const listeners = new Set<() => void>();
let active: Detail | null = null;
let state: WalletState = { status: "disconnected", address: null, chainId: null, wallets: [], current: null, error: null };

function emit(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function remember(rdns: string | null) {
  try {
    if (rdns) localStorage.setItem(STORAGE_KEY, rdns);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable: the wallet simply does not reconnect by itself
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function walletErrorMessage(error: unknown): string {
  const code = (error as { code?: number } | null)?.code;
  if (code === 4001) return "Request rejected in the wallet.";
  if (code === -32002) return "The wallet already has a pending request: open it.";
  const text = error instanceof Error ? error.message : String(error);
  if (/exceeds the balance of the account|insufficient funds/i.test(text)) return "Not enough ETH for this amount plus gas.";
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

const onAccounts = (accounts: unknown) => {
  const list = accounts as string[] | undefined;
  if (!list?.length) drop();
  else emit({ status: "connected", address: getAddress(list[0]) });
};
const onChain = (chainId: unknown) => emit({ chainId: Number(chainId) });
const onDisconnect = () => drop();

function attach(detail: Detail) {
  detach();
  active = detail;
  detail.provider.on?.("accountsChanged", onAccounts);
  detail.provider.on?.("chainChanged", onChain);
  detail.provider.on?.("disconnect", onDisconnect);
}

function detach() {
  if (!active) return;
  active.provider.removeListener?.("accountsChanged", onAccounts);
  active.provider.removeListener?.("chainChanged", onChain);
  active.provider.removeListener?.("disconnect", onDisconnect);
  active = null;
}

function drop() {
  detach();
  remember(null);
  emit({ status: "disconnected", address: null, chainId: null, current: null });
}

async function reconnect(detail: Detail) {
  try {
    const accounts = (await detail.provider.request({ method: "eth_accounts" })) as string[];
    if (!accounts.length || state.status !== "disconnected") return;
    const chainId = Number(await detail.provider.request({ method: "eth_chainId" }));
    attach(detail);
    emit({ status: "connected", address: getAddress(accounts[0]), chainId, current: detail.info, error: null });
  } catch {
    // stays disconnected until the user connects
  }
}

function announce(detail: Detail) {
  if (!detail?.info?.uuid || !detail.provider || details.has(detail.info.uuid)) return;
  details.set(detail.info.uuid, detail);
  emit({ wallets: [...details.values()].map((d) => d.info) });
  if (state.status === "disconnected" && remembered() === detail.info.rdns) void reconnect(detail);
}

let discovering = false;
export function startWalletDiscovery() {
  if (discovering || typeof window === "undefined") return;
  discovering = true;
  window.addEventListener("eip6963:announceProvider", (event) => announce((event as CustomEvent<Detail>).detail));
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Wallets without EIP-6963 still inject window.ethereum.
  window.setTimeout(() => {
    const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (injected && details.size === 0) announce({ info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }, provider: injected });
  }, 500);
}

export async function connectWallet(uuid?: string) {
  const detail = uuid ? details.get(uuid) : [...details.values()][0];
  if (!detail) {
    emit({ error: "No browser wallet found. Install MetaMask, Rabby or another Ethereum wallet." });
    return;
  }
  emit({ status: "connecting", error: null });
  try {
    const accounts = (await detail.provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts.length) throw new Error("The wallet returned no account.");
    const chainId = Number(await detail.provider.request({ method: "eth_chainId" }));
    attach(detail);
    remember(detail.info.rdns);
    emit({ status: "connected", address: getAddress(accounts[0]), chainId, current: detail.info, error: null });
  } catch (error) {
    emit({ status: "disconnected", error: walletErrorMessage(error) });
  }
}

export function disconnectWallet() {
  drop();
}

/** Ask the wallet for Ethereum, adding the network when the wallet does not know it. */
export async function switchToAppChain() {
  if (!active) throw new Error("Connect a wallet first.");
  const chainId = numberToHex(CONFIG.chainId);
  try {
    await active.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw new Error(walletErrorMessage(error));
    await active.provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        // The public endpoint only: the wallet keeps this URL for every site, and the build's private one is domain-restricted.
        chainId, chainName: CONFIG.chainName, rpcUrls: [CONFIG.publicRpcUrl], blockExplorerUrls: [CONFIG.explorer],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      }],
    });
  }
  emit({ chainId: Number(await active.provider.request({ method: "eth_chainId" })) });
}

export function getWalletState(): WalletState {
  return state;
}

/** A viem wallet client on the connected account, or null. */
export function getWalletClient() {
  if (!active || !state.address) return null;
  return createWalletClient({ account: state.address, chain, transport: custom(active.provider) });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWallet(): WalletState {
  return useSyncExternalStore(subscribe, getWalletState, getWalletState);
}
