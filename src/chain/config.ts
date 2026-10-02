import { DEPLOYMENT, NETWORK } from "./deployment.ts";
export type { RuntimeHash } from "./deployment.ts";
export { sameAddress } from "./address.ts";

// A Sepolia build uses its own public RPC only: the build variables name mainnet
// endpoints and the mainnet data worker.
const sepolia = NETWORK === "sepolia";
const sepoliaRpc = import.meta.env.VITE_SEPOLIA_RPC_URL || DEPLOYMENT.publicRpcUrl;
const dataUrl = sepolia ? "" : (import.meta.env.VITE_DATA_URL || "").replace(/\/$/, "");

export const CONFIG = {
  ...DEPLOYMENT,
  // Direct reads use the public RPC unless the build explicitly supplies an override.
  rpcUrl: sepolia ? sepoliaRpc : dataUrl ? DEPLOYMENT.publicRpcUrl : (import.meta.env.VITE_RPC_URL || DEPLOYMENT.publicRpcUrl),
  // Reads the shared worker does not serve (history, the block check, every fallback) use this app-only endpoint
  // when the build names one. It never reaches a wallet, which keeps the public RPC.
  fallbackRpcUrl: sepolia ? sepoliaRpc : import.meta.env.VITE_FALLBACK_RPC_URL || DEPLOYMENT.publicRpcUrl,
  dataUrl,
  turnstileSiteKey: sepolia ? "" : import.meta.env.VITE_TURNSTILE_SITE_KEY || "",
};

export const txUrl = (hash: string) => `${CONFIG.explorer}/tx/${hash}`;
export const addressUrl = (value: string) => `${CONFIG.explorer}/address/${value}`;
export const tokenUrl = (value: string) => `${CONFIG.explorer}/token/${value}`;
export const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
