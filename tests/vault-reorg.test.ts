import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { CubitTokenAbi, CubitVaultAbi } from "../src/chain/abi.ts";
import { readVault } from "../src/chain/vault.ts";
import { createRelayRequest } from "../src/chain/relayRequest.ts";
import { PUBLIC_DEADLINE_MS } from "../src/chain/requestPool.ts";
import { address, config, context, flush, head } from "./helpers.ts";

const block = head(100), vault = address(10), account = address(40);
const sharedVault = () => readVault(context({ readContract: async () => 100n }), vault, true, null, block);
type Request = { method: string; params?: unknown };

function answer(request: Request) {
  assert.equal(request.method, "eth_call", "hash-pinned getters must bypass automatic multicall");
  const [tx, selector] = request.params as [{ to: string; data: Hex }, unknown];
  assert.deepEqual(selector, { blockHash: block.hash, requireCanonical: true });
  const abi = tx.to.toLowerCase() === vault.toLowerCase() ? CubitVaultAbi : CubitTokenAbi;
  const { functionName } = decodeFunctionData({ abi, data: tx.data });
  assert.ok(["balanceOf", "pendingCubit", "unlockAt", "lastRewardAt", "allowance"].includes(functionName));
  return encodeFunctionResult({ abi, functionName, result: 1n });
}

test("real viem vault calls retain their canonical hash through every relay fallback", async () => {
  const shared = await sharedVault();
  const cases: [string, (() => Promise<Response>) | null][] = [
    ["no session", null],
    ...[400, 401, 403, 413, 415, 422, 429, 503].map((status): [string, () => Promise<Response>] =>
      [`HTTP ${status}`, async () => new Response(null, { status })]),
    ["network failure", async () => { throw new TypeError("Network unavailable"); }],
    ["RPC refusal", async () => Response.json({ error: { code: -32000, message: "Non-canonical block" } })],
    ["missing result", async () => Response.json({})],
  ];
  for (const [name, refuse] of cases) {
    const requests: Request[] = [];
    const request = createRelayRequest({ url: "https://offline.invalid", token: () => refuse ? "session" : null,
      request: async (_, init) => {
        answer(JSON.parse(init!.body as string)); // The relay receives the exact same hash too.
        return refuse!();
      },
      fallback: async (args) => { requests.push(args); return answer(args); },
    });
    const client = createPublicClient({ chain: mainnet, batch: { multicall: { wait: 1 } },
      transport: custom({ request }, { retryCount: 0 }) });
    const view = await readVault({ client, config }, vault, true, account, block, shared);
    assert.equal(requests.length, 6, name);
    assert.equal(view.totalStaked, 100n, name);
    assert.deepEqual(view.position, { staked: 1n, pending: 1n, unlockAt: 1n, lastRewardAt: 1n, wallet: 1n, allowance: 1n });
    assert.deepEqual(view.block, block);
  }
});

test("the relay success path also receives six independent canonical hash calls", async () => {
  let requests = 0;
  const request = createRelayRequest({ url: "https://offline.invalid", token: () => "session",
    request: async (_, init) => { requests++; return Response.json({ result: answer(JSON.parse(init!.body as string)) }); },
    fallback: async () => assert.fail("A successful relay must not use fallback"),
  });
  const client = createPublicClient({ chain: mainnet, batch: { multicall: { wait: 1 } },
    transport: custom({ request }, { retryCount: 0 }) });
  const view = await readVault({ client, config }, vault, true, account, block, await sharedVault());
  assert.equal(view.position?.staked, 1n);
  assert.equal(requests, 6);
});

test("relay timeouts and the following cooldown preserve EIP-1898 on fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fallbacks = 0, relayCalls = 0;
  const request = createRelayRequest({ url: "https://offline.invalid", token: () => "session", now: () => 0,
    request: async (_, init) => {
      relayCalls++;
      answer(JSON.parse(init!.body as string));
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    }, fallback: async (args) => { fallbacks++; return answer(args); },
  });
  const client = createPublicClient({ chain: mainnet, batch: { multicall: { wait: 1 } },
    transport: custom({ request }, { retryCount: 0 }) });
  const shared = await sharedVault();
  const pending = readVault({ client, config }, vault, true, account, block, shared);
  await flush();
  t.mock.timers.tick(PUBLIC_DEADLINE_MS);
  assert.equal((await pending).position?.staked, 1n);
  assert.equal(fallbacks, 6);
  const beforeCooldown = relayCalls;
  assert.ok(beforeCooldown > 0);
  await readVault({ client, config }, vault, true, account, block, shared);
  assert.equal(fallbacks, 12);
  assert.equal(relayCalls, beforeCooldown, "the paused relay is bypassed without changing the block selector");
});

test("unsupported EIP-1898 and a reorg between personal getters reject the entire vault", async () => {
  for (const failAfter of [0, 3]) {
    let requests = 0;
    const message = failAfter ? "Block is no longer canonical" : "Hash selector unsupported";
    const request = createRelayRequest({ url: "https://offline.invalid", token: () => null,
      fallback: async (args) => {
        const result = answer(args);
        if (++requests > failAfter) throw { code: -32602, message };
        return result;
      },
    });
    const client = createPublicClient({ chain: mainnet, batch: { multicall: { wait: 1 } },
      transport: custom({ request }, { retryCount: 0 }) });
    await assert.rejects(readVault({ client, config }, vault, true, account, block, await sharedVault()),
      new RegExp(message));
    assert.equal(requests, 6, "no retry with a number or latest, even after some getters succeeded");
  }
});

test("shared vault provenance must match before any personal getter starts", async () => {
  const shared = await sharedVault();
  const ctx = context({ readContract: async () => assert.fail("Unproven public values must not be extended") });
  for (const bad of [
    { ...shared, block: undefined },
    { ...shared, block: head(100, 1) }, // Equal number and timestamp are not proof of a common state.
    { ...shared, block: { ...block, number: 99n } },
    { ...shared, block: { ...block, timestamp: block.timestamp - 1n } },
    { ...shared, chainTime: block.timestamp - 1n },
    { ...shared, vault: address(11) },
  ]) await assert.rejects(readVault(ctx, vault, true, account, block, bad as typeof shared), /snapshot changed/);
});
