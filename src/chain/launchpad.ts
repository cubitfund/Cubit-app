// The public launchpad: the registered Forge, its launched tokens and its governance vault. A launch is prepared in the
// browser exactly like script/ForgeLaunch.s.sol: link the CubitHook creation code with the deployment's libraries and
// check it against the Forge's frozen hash, predict the child token's CREATE2 address, then mine the hook salt the
// Forge binds to the launcher so that the child hook's address carries the six hook flags.
import { concat, encodeAbiParameters, getAddress, keccak256, parseEventLogs, stringToHex, toHex, zeroAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { CubitForgeAbi, CubitGovernanceVaultAbi, CubitHookAbi, CubitTokenAbi, CubitV2Abi } from "./abi.ts";
import { sameAddress } from "./address.ts";
import { FORGE_TOKEN_CREATION_CODE, HOOK_CREATION_CODE, HOOK_LINK_REFERENCES } from "./bytecode.ts";
import type { ReadContext, BlockSnapshot } from "./readContext.ts";
import { createLogCursor, type CursorRow, type CursorStore } from "./logCursor.ts";
import { createMetadataCache } from "./tokenMetadata.ts";
import { governanceDetailError, readGovernanceDetails, type GovernanceDetails } from "./tranches.ts";
import { chunked } from "./events.ts";
import { poolIdOf, type MarketRef } from "./market.ts";
import type { WriteRequest } from "./writeRequest.ts";

/** Hooks.AFTER_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | AFTER_SWAP | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA. */
export const HOOK_FLAGS = 0x18cc;
const HOOK_MASK = 0x3fff;
export const NAME_MAX_BYTES = 64;
export const SYMBOL_MAX_BYTES = 12;
/** Tranches one claim walks at most. */
export const CLAIM_BATCH = 64n;

export type ForgeView = {
  forge: Address;
  launchFee: bigint;
  launches: bigint;
  governanceVault: Address;
  hookCreationCodeHash: Hex;
  /** The creation code this build links has the hash the Forge froze. */
  templateMatches: boolean;
  launchEth: bigint;
  poolManager: Address;
};

export type ChildLaunch = MarketRef & { forge: Address; launcher: Address; team: Address; fee: bigint; tx: Hex };

/** A successful replacement receipt may be a cancellation rather than the prepared launch. */
export function confirmsChildLaunch(
  receipt: Pick<TransactionReceipt, "status" | "logs">, expected: Pick<ChildLaunch, "forge" | "token" | "hook">,
): boolean {
  if (receipt.status !== "success") return false;
  return parseEventLogs({ abi: CubitForgeAbi, eventName: "ChildLaunched", logs: receipt.logs, strict: true }).some((log) =>
    sameAddress(log.address, expected.forge) && sameAddress(log.args.token, expected.token) && sameAddress(log.args.hook, expected.hook));
}

/** The name CubitV2 gives the Forge in `ModuleUpdated`: "FORGE" as bytes32. */
const FORGE_MODULE = stringToHex("FORGE", { size: 32 });

export async function readForge({ client: publicClient, config: CONFIG }: ReadContext, forge: Address, block: BlockSnapshot): Promise<ForgeView> {
  const at = { address: forge, abi: CubitForgeAbi, blockNumber: block.number } as const;
  const [launchFee, launches, governanceVault, hookCreationCodeHash] = await Promise.all([
    publicClient.readContract({ ...at, functionName: "launchFee" }),
    publicClient.readContract({ ...at, functionName: "launches" }),
    publicClient.readContract({ ...at, functionName: "governanceVault" }),
    publicClient.readContract({ ...at, functionName: "hookCreationCodeHash" }),
  ]);
  const [launchEth, poolManager] = await Promise.all([
    publicClient.readContract({ address: CONFIG.hook, abi: CubitHookAbi, functionName: "LAUNCH_ETH", blockNumber: block.number }),
    publicClient.readContract({ address: CONFIG.hook, abi: CubitHookAbi, functionName: "poolManager", blockNumber: block.number }),
  ]);
  return {
    forge, launchFee, launches, governanceVault, hookCreationCodeHash, launchEth, poolManager,
    templateMatches: keccak256(linkedHookCreationCode(CONFIG)) === hookCreationCodeHash.toLowerCase(),
  };
}

/** Cursor state is owned by the caller (one instance per configured chain), never by React or localStorage. */
export function createLaunchpadReader(ctx: ReadContext, store?: CursorStore) {
  const { client, config } = ctx;
  const metadata = createMetadataCache(store);
  const hashAt = async (number: bigint) => (await client.getBlock({ blockNumber: number })).hash;
  type Registration = CursorRow & { previous: Address; current: Address };
  const registry = createLogCursor<Registration>(config.deployBlock, (from, to) => chunked(from, to, async (lo, hi) => {
    const logs = await client.getContractEvents({ address: config.v2, abi: CubitV2Abi, eventName: "ModuleUpdated", args: { module: FORGE_MODULE }, fromBlock: lo, toBlock: hi });
    return logs.map((log) => ({
      id: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber!, blockHash: log.blockHash!,
      previous: log.args.previous!, current: log.args.current!,
    }));
  }), hashAt, store ? { store, key: "launches:registry" } : undefined);
  type Launch = CursorRow & { token: Address; hook: Address; launcher: Address; team: Address; fee: bigint; tx: Hex };
  const forges = new Map<string, { first: bigint; read: (block: BlockSnapshot) => Promise<Launch[]>; known: Launch[] }>();

  return async function readAllChildren(block: BlockSnapshot): Promise<ChildLaunch[]> {
    const registrations = await registry.read(block);
    const starts = new Map<Address, bigint>();
    const add = (address: Address, from: bigint) => {
      const key = address.toLowerCase() as Address;
      if (key !== zeroAddress && !starts.has(key)) starts.set(key, from);
    };
    for (const r of registrations) { add(r.previous, config.deployBlock); add(r.current, BigInt(r.block)); }
    // The registration logs are authoritative: a reorg may remove the currently deployed Forge too.
    for (const [key, entry] of forges) if (!starts.has(key as Address)) {
      for (const log of entry.known) metadata.forget(config.chainId, log.token);
      forges.delete(key);
    }
    const children: ChildLaunch[] = [];
    // Forges are walked in order: avoid a growing unbounded fan-out during initial indexing.
    for (const [forge, first] of starts) {
      let entry = forges.get(forge);
      if (!entry || entry.first !== first) {
        for (const old of entry?.known ?? []) metadata.forget(config.chainId, old.token);
        const cursor = createLogCursor<Launch>(first, (from, to) => chunked(from, to, async (lo, hi) => {
          const logs = await client.getContractEvents({ address: forge, abi: CubitForgeAbi, eventName: "ChildLaunched", fromBlock: lo, toBlock: hi });
          return logs.map((log) => ({
            ...log.args as { token: Address; hook: Address; launcher: Address; team: Address; fee: bigint },
            id: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber!, blockHash: log.blockHash!, tx: log.transactionHash!,
          }));
        }), hashAt, store ? { store, key: `launches:${forge}:${first}` } : undefined);
        entry = { first, read: cursor.read, known: [] };
        forges.set(forge, entry);
      }
      const logs = await entry.read(block);
      for (const old of entry.known) if (!logs.some((l) => l.id === old.id && l.blockHash === old.blockHash)) metadata.forget(config.chainId, old.token);
      entry.known = logs;
      for (let i = 0; i < logs.length; i += 8) {
        children.push(...await Promise.all(logs.slice(i, i + 8).map(async (log) => {
          const names = await metadata.read(config.chainId, log.token, async () => {
            const at = { address: log.token, abi: CubitTokenAbi, blockNumber: block.number } as const;
            const [name, symbol] = await Promise.all([client.readContract({ ...at, functionName: "name" }), client.readContract({ ...at, functionName: "symbol" })]);
            return { name, symbol };
          }, log.blockHash);
          return { ...log, ...names, forge, poolId: poolIdOf(log.token, log.hook), fromBlock: BigInt(log.block), parent: false };
        })));
      }
    }
    return children.sort((a, b) => a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0);
  };
}

/** CubitHook creation code with BandLib and WallLib at the deployment's addresses. */
export function linkedHookCreationCode(CONFIG: ReadContext["config"]): Hex {
  let code = HOOK_CREATION_CODE.slice(2);
  const addresses: Record<string, string> = { BandLib: CONFIG.bandLib, WallLib: CONFIG.wallLib };
  for (const [library, positions] of Object.entries(HOOK_LINK_REFERENCES)) {
    const value = addresses[library]?.slice(2).toLowerCase();
    if (!value) throw new Error(`Unknown library ${library}.`);
    for (const { start, length } of positions) code = code.slice(0, start * 2) + value + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}

export const utf8Length = (value: string) => new TextEncoder().encode(value).length;

export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** keccak256(abi.encode(launcher, salt)): the salt the Forge actually uses. */
const boundSalt = (launcher: Address, salt: Hex): Hex => keccak256(`0x${launcher.slice(2).toLowerCase().padStart(64, "0")}${salt.slice(2)}`);

function create2(deployer: Address, salt: Hex, initCodeHash: Hex): string {
  return keccak256(concat(["0xff", deployer, salt, initCodeHash])).slice(-40);
}

export function predictChildToken(forge: Address, launcher: Address, tokenSalt: Hex, name: string, symbol: string): Address {
  const initCode = concat([FORGE_TOKEN_CREATION_CODE, encodeAbiParameters([{ type: "string" }, { type: "string" }], [name, symbol])]);
  return getAddress(`0x${create2(forge, boundSalt(launcher, tokenSalt), keccak256(initCode))}`);
}

/** The address the Forge's CREATE2 gives a child hook for one launcher's salt. */
export function childHookAddress(forge: Address, launcher: Address, hookSalt: Hex, initCodeHash: Hex): Address {
  return getAddress(`0x${create2(forge, boundSalt(launcher, hookSalt), initCodeHash)}`);
}

/** The six flags the hook's constructor requires of its own address; the last two bytes, checksummed or not. */
export const hasHookFlags = (address: string) => (parseInt(address.slice(-4), 16) & HOOK_MASK) === HOOK_FLAGS;

export function childHookInitCodeHash(creationCode: Hex, poolManager: Address, token: Address, team: Address, launchEth: bigint): Hex {
  return keccak256(concat([creationCode, encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    [poolManager, token, team, launchEth],
  )]));
}

/** Search hook salts 0, 1, 2… until the child hook's CREATE2 address carries the flags and holds no code (~16k tries). */
export async function mineHookSalt(
  { client: publicClient }: ReadContext,
  forge: Address,
  launcher: Address,
  initCodeHash: Hex,
  onProgress?: (tries: number) => void,
  cancelled?: () => boolean,
): Promise<{ salt: Hex; hook: Address; tries: number }> {
  for (let i = 0; i < 4_000_000; i++) {
    if (cancelled?.()) throw new Error("Launch preparation cancelled.");
    // getAddress checksums with another keccak: only candidates, never every try.
    const address = create2(forge, boundSalt(launcher, toHex(i, { size: 32 })), initCodeHash);
    if (hasHookFlags(address)) {
      const hook = getAddress(`0x${address}`);
      const code = await publicClient.getCode({ address: hook });
      if (cancelled?.()) throw new Error("Launch preparation cancelled.");
      if (!code || code === "0x") return { salt: toHex(i, { size: 32 }), hook, tries: i + 1 };
    }
    if (i % 2_000 === 1_999) {
      onProgress?.(i + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled?.()) throw new Error("Launch preparation cancelled.");
    }
  }
  throw new Error("No hook salt found.");
}

export function launchRequest(forge: Address, fee: bigint, name: string, symbol: string, team: Address, tokenSalt: Hex, hookSalt: Hex, creationCode: Hex): WriteRequest {
  return { address: forge, abi: CubitForgeAbi, functionName: "launch", args: [name, symbol, team, tokenSalt, hookSalt, creationCode], value: fee };
}

export type GovernanceAsset = {
  token: Address;
  symbol: string;
  held: bigint;
  /** Null is unknown/not requested, never a zero balance. Shared snapshots contain no detail. */
  details: GovernanceDetails | null;
  detailError: string | null;
};

export type GovernanceView = {
  vault: Address;
  deployer: Address;
  lockDuration: bigint;
  lockExtension: bigint;
  block: BlockSnapshot;
  assets: GovernanceAsset[];
};

/** Public polling, including the owner's, reads only held. Detail requires an explicit asset key in pages. */
export async function readGovernance(
  { client: publicClient }: ReadContext, vault: Address, tokens: { token: Address; symbol: string }[],
  block: BlockSnapshot, account: Address | null = null, pages: Record<string, number | null> = {}, shared?: GovernanceView,
): Promise<GovernanceView> {
  const at = { address: vault, abi: CubitGovernanceVaultAbi, blockHash: block.hash, requireCanonical: true } as const;
  if (shared && (shared.vault.toLowerCase() !== vault.toLowerCase() || shared.block.hash !== block.hash ||
      shared.block.number !== block.number || shared.block.timestamp !== block.timestamp)) throw new Error("Governance snapshot changed.");
  const [deployer, lockDuration, lockExtension] = shared ? [shared.deployer, shared.lockDuration, shared.lockExtension] : await Promise.all([
    publicClient.readContract({ ...at, functionName: "deployer" }),
    publicClient.readContract({ ...at, functionName: "LOCK_DURATION" }),
    publicClient.readContract({ ...at, functionName: "lockExtension" }),
  ]);
  const owner = account?.toLowerCase() === deployer.toLowerCase();
  const assets: GovernanceAsset[] = [];
  const unique = [...new Map([{ token: zeroAddress, symbol: "ETH" }, ...tokens].map((t) => [t.token.toLowerCase(), t])).values()];
  for (let start = 0; start < unique.length; start += 8) {
    assets.push(...await Promise.all(unique.slice(start, start + 8).map(async ({ token, symbol }): Promise<GovernanceAsset> => {
      const publicAsset = shared?.assets.find((a) => a.token.toLowerCase() === token.toLowerCase());
      if (shared && !publicAsset) throw new Error("Governance asset absent from the snapshot.");
      const held = publicAsset ? publicAsset.held : await publicClient.readContract({ ...at, functionName: "held", args: [token] });
      return { token, symbol, held, details: null, detailError: null };
    })));
  }
  if (owner) {
    for (const asset of assets) {
      if (!Object.prototype.hasOwnProperty.call(pages, asset.token.toLowerCase())) continue;
      try {
        asset.details = await readGovernanceDetails({ client: publicClient }, vault, asset.token, asset.held,
          block, pages[asset.token.toLowerCase()]);
      } catch (error) {
        asset.detailError = governanceDetailError(error);
      }
    }
  }
  return { vault, deployer, lockDuration, lockExtension,
    block: { number: block.number, hash: block.hash, timestamp: block.timestamp }, assets };
}

export const governanceClaimRequest = (vault: Address, token: Address): WriteRequest => ({
  address: vault, abi: CubitGovernanceVaultAbi, functionName: "claim", args: [token, CLAIM_BATCH],
});

export const extendLockRequest = (vault: Address, seconds: bigint): WriteRequest => ({
  address: vault, abi: CubitGovernanceVaultAbi, functionName: "extendLock", args: [seconds],
});

export const deliverAbsorbedRequest = (hook: Address): WriteRequest => ({
  address: hook, abi: CubitHookAbi, functionName: "deliverAbsorbed",
});
