// The deployment this build points at: the records copied by scripts/sync-deployment.mjs, plus the canonical Uniswap
// v4 periphery. Mainnet, unless the build sets VITE_NETWORK=sepolia. Module
// addresses published here are the ones deployed; the app still reads the registry (CubitV2) at every refresh,
// because the team can replace the Vault, Router, Lens or Forge.
import { zeroAddress, type Address, type Hex } from "viem";
import * as mainnetRecords from "./deployments/mainnet.ts";
import * as sepoliaRecords from "./deployments/sepolia.ts";

/** The network this build targets. Outside Vite (tests, the data worker) import.meta.env is absent: mainnet. */
export const NETWORK: "mainnet" | "sepolia" =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_NETWORK === "sepolia" ? "sepolia" : "mainnet";
const records = NETWORK === "sepolia" ? sepoliaRecords as unknown as typeof mainnetRecords : mainnetRecords;
const { launchRecord, launchpadRecord, launchpadV2Record } = records;

/** Per network: the public endpoint (the default and fallback of every read, and the only RPC handed to a wallet),
 *  the explorer, and the canonical Uniswap v4 periphery (Uniswap's v4 deployments). */
const NETWORKS = {
  mainnet: {
    chainName: "Ethereum", publicRpcUrl: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io",
    quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203", universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    // Paying a launchpad v2 pair with ETH: Uniswap v3 routes from WETH, direct or through USDC (ethRoute.ts).
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", v3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    routeHub: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  sepolia: {
    chainName: "Sepolia", publicRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io",
    quoter: "0x61B3f2011A92d183C7dbaDBdA940a7555Ccf9227", universalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
    // The test USDC of deployments/quotes/11155111.json (contracts repository), with test v3 pools (script/EthRoutePools.s.sol).
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", v3Quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    routeHub: "0x75Ee89e33401126c0C02Bccd4Ec79c4b5380af43",
  },
} as const;
const NET = NETWORKS[NETWORK];

export type RuntimeHash = { contract: string; address: Address; keccak256: Hex };

const launch = launchRecord as typeof launchRecord & { launchTimestamp?: number; runtimeCodeHashes?: RuntimeHash[]; transactions?: Hex[] };
const launchpad = launchpadRecord as {
  forge: string; governanceVault: string; governanceDeployer: string; hookCreationCodeHash: Hex;
  deployBlock: number; runtimeCodeHashes: RuntimeHash[]; transactions: Hex[];
} | null;

/** Launchpad v2 (CubitForgeV2), absent until it is deployed, verified and promoted. Launch values and quotes are read
 *  from the Forge itself: large integers would lose precision as JSON numbers. */
const launchpadV2 = launchpadV2Record as {
  forge: string; quoteWallLib: string; deployBlock: number;
  /** 3 for a CubitForgeV3 (ERC-20 pairs token-first), absent for a CubitForgeV2. */
  version?: number; tokenFirstWallLib?: string;
  /** Earlier launchpad v2/v3 Forges whose children the app keeps listing and trading. */
  previousForges?: { forge: string; deployBlock: number; version?: number }[];
} | null;

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`Deployment record: invalid ${field}.`);
  return value as Address;
}

/** Manifests write large integers as strings; small ones as JSON numbers. */
const big = (value: unknown): bigint => BigInt(String(value));

export const DEPLOYMENT = {
  chainId: launchRecord.chainId,
  chainName: NET.chainName,
  publicRpcUrl: NET.publicRpcUrl,
  explorer: NET.explorer,

  token: address(launchRecord.token, "token"),
  hook: address(launchRecord.hook, "hook"),
  lens: address(launchRecord.lens, "lens"),
  router: address(launchRecord.router, "router"),
  v2: address(launchRecord.v2, "v2"),
  vault: address(launchRecord.vault, "vault"),
  launch: address(launchRecord.launch, "launch"),
  bandLib: address(launchRecord.bandLib, "bandLib"),
  wallLib: address(launchRecord.wallLib, "wallLib"),
  poolManager: address(launchRecord.poolManager, "poolManager"),
  poolId: launchRecord.poolId as Hex,
  teamAddress: address(launchRecord.teamAddress, "teamAddress"),
  deployBlock: big(launchRecord.deployBlock),
  launchTimestamp: launch.launchTimestamp ?? null,
  launchSqrtPriceX96: big(launchRecord.initialSqrtPriceX96),
  poolFee: Number(launchRecord.fee),
  tickSpacing: Number(launchRecord.tickSpacing),
  runtimeCodeHashes: launch.runtimeCodeHashes ?? [],
  launchTransactions: launch.transactions ?? [],

  forge: launchpad ? address(launchpad.forge, "forge") : zeroAddress,
  governanceVault: launchpad ? address(launchpad.governanceVault, "governanceVault") : zeroAddress,
  governanceDeployer: launchpad ? address(launchpad.governanceDeployer, "governanceDeployer") : zeroAddress,
  hookCreationCodeHash: launchpad?.hookCreationCodeHash ?? null,
  launchpadDeployBlock: launchpad ? big(launchpad.deployBlock) : null,
  launchpadRuntimeCodeHashes: launchpad?.runtimeCodeHashes ?? [],
  launchpadTransactions: launchpad?.transactions ?? [],

  forgeV2: launchpadV2 ? address(launchpadV2.forge, "forgeV2") : zeroAddress,
  quoteWallLib: launchpadV2 ? address(launchpadV2.quoteWallLib, "quoteWallLib") : zeroAddress,
  launchpadV2DeployBlock: launchpadV2 ? big(launchpadV2.deployBlock) : null,
  /** 3 when the Forge in force puts every ERC-20 pair's token first (CubitForgeV3). */
  launchpadV2Version: launchpadV2?.version ?? 2,
  tokenFirstWallLib: launchpadV2?.tokenFirstWallLib ? address(launchpadV2.tokenFirstWallLib, "tokenFirstWallLib") : zeroAddress,
  launchpadV2PreviousForges: (launchpadV2?.previousForges ?? []).map((f) => ({
    forge: address(f.forge, "previousForges.forge"), deployBlock: big(f.deployBlock), version: f.version ?? 2,
  })),

  quoter: NET.quoter as Address,
  universalRouter: NET.universalRouter as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  weth: NET.weth as Address,
  v3Quoter: NET.v3Quoter as Address,
  routeHub: NET.routeHub as Address,
} as const;
