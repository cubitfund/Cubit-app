import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, stringToHex } from "viem";
import { SCHEMA_VERSION, SnapshotClient, parseSnapshot, snapshotStale, stringifyData, type DataSnapshot } from "../src/chain/snapshot.ts";
import { createRelayRequest } from "../src/chain/relayRequest.ts";
import { MarketClosedError } from "../src/chain/market.ts";
import { head, hash, address } from "./helpers.ts";
import type { MarketHistory } from "../src/chain/events.ts";

const sample = (): DataSnapshot => ({
  schemaVersion: SCHEMA_VERSION, chainId: 1, block: head(100), producedAt: 1_200_000,
  market: { block: 100n, blockHash: hash(100) }, registry: {}, children: [], histories: {}, eventTimes: {},
  vaults: [], markets: {}, forge: null, governance: null,
} as unknown as DataSnapshot);

test("snapshot use expires immediately beyond 60 seconds since verification", () => {
  const s = sample();
  assert.equal(snapshotStale(s, s.producedAt + 60_000), false);
  assert.equal(snapshotStale(s, s.producedAt + 60_001), true);
});

test("a recently verified snapshot tolerates a block up to five minutes old", () => {
  const s = sample(), blockTime = Number(s.block.timestamp) * 1_000;
  for (const age of [60_001, 240_000, 300_000]) {
    const now = blockTime + age;
    assert.equal(snapshotStale({ ...s, producedAt: now }, now), false);
  }
  const now = blockTime + 300_001;
  assert.equal(snapshotStale({ ...s, producedAt: now }, now), true);
});

test("snapshot client coalesces downloads, validates the schema and detects stale data without losing the last snapshot", async () => {
  const s = sample(); let count = 0, offline = false;
  const client = new SnapshotClient("https://data.invalid", async (url) => {
    assert.equal(url, "https://data.invalid/data/mainnet/latest.json");
    count++; if (offline) throw Error("offline"); return new Response(stringifyData(s));
  });
  await Promise.all([client.refresh(), client.refresh(), client.refresh()]);
  assert.equal(count, 1); assert.deepEqual(client.at(s.block), s);
  assert.equal(snapshotStale(s, s.producedAt + 60_001), true);
  assert.equal(snapshotStale(s, s.producedAt), false);
  assert.throws(() => parseSnapshot(stringifyData({ ...s, schemaVersion: 999 })));
  assert.throws(() => parseSnapshot(stringifyData({ ...s, chainId: 11155111 })));
  offline = true; await assert.rejects(client.refresh());
  assert.deepEqual(client.current, s); assert.ok(client.error);
});

test("closed-market responses preserve the typed reason and clear download errors without losing retained snapshots", async () => {
  const s = sample(); let status: "shared" | "failed" | "closed" = "shared", requests = 0;
  const client = new SnapshotClient("https://data.invalid", async () => {
    requests++;
    if (status === "shared") return new Response(stringifyData(s));
    if (status === "failed") return new Response(null, { status: 500 });
    return Response.json({ code: "MARKET_CLOSED", error: "The market is not open yet." }, { status: 503 });
  });
  await client.refresh();
  status = "failed";
  await assert.rejects(client.refresh(), /Shared data unavailable/);
  const errors: (string | null)[] = [];
  const stop = client.subscribe(() => errors.push(client.error));
  status = "closed";
  await Promise.all(Array.from({ length: 10 }, () => assert.rejects(client.refresh(), MarketClosedError)));
  assert.equal(requests, 3, "closed responses are coalesced too");
  assert.deepEqual(errors, [null]);
  assert.equal(client.error, null);
  assert.deepEqual(client.current, s);
  assert.deepEqual(client.at(s.block), s, "in-flight readers retain their snapshot");
  status = "shared";
  assert.deepEqual(await client.refresh(), s);
  assert.equal(client.error, null);
  stop();
});

test("only an explicit closed-market code on a 503 latest response is expected", async () => {
  for (const [status, body] of [
    [500, { code: "MARKET_CLOSED" }], [200, { code: "MARKET_CLOSED" }],
    [503, { error: "The CUBIT market is not open yet." }], [503, { code: "UNKNOWN" }],
    [503, null], [503, "MARKET_CLOSED"], [503, { code: ["MARKET_CLOSED"] }],
  ] as const) {
    const client = new SnapshotClient("https://data.invalid", async () => Response.json(body, { status }));
    await assert.rejects(client.refresh(), /Shared data unavailable/);
    assert.equal(client.error, "Shared data unavailable. Last snapshot retained.");
  }
  const client = new SnapshotClient("https://data.invalid", async () => new Response('{"code":"MARKET_CLOSED"', { status: 503 }));
  await assert.rejects(client.refresh(), /Shared data unavailable/);
});

test("a closed-market code on a history response remains a history failure", async () => {
  const s = sample(), token = address(1);
  s.histories[token] = { parts: [{ from: 1n, to: 90n, path: `/data/mainnet/history/${token}/1-90/${hash(90)}.json` }],
    recent: { fromBlock: 91n, toBlock: 100n, events: [], swaps: [] } };
  const client = new SnapshotClient("https://data.invalid", async (url) => String(url).endsWith("latest.json")
    ? new Response(stringifyData(s)) : Response.json({ code: "MARKET_CLOSED" }, { status: 503 }));
  await client.refresh();
  await assert.rejects(client.history(token, s.block), (e) => e instanceof Error && !(e instanceof MarketClosedError));
});

test("an explicit test network override never changes the default mainnet validation", async () => {
  const legacy = { ...sample(), chainId: 11155111 };
  assert.throws(() => parseSnapshot(stringifyData(legacy)), /Unsupported/);
  const client = new SnapshotClient("https://data.invalid", async (url) => {
    assert.equal(url, "https://data.invalid/data/sepolia/latest.json");
    return new Response(stringifyData(legacy));
  }, { chainId: 11155111, path: "/data/sepolia" });
  assert.equal((await client.refresh()).chainId, 11155111);
});

test("frozen history is reused while the replacement tail removes events orphaned by a reorg", async () => {
  const s = sample(), token = address(1);
  const frozen: MarketHistory = { fromBlock: 1n, toBlock: 90n, events: [], swaps: [] };
  const text = stringifyData(frozen), path = `/data/mainnet/history/${token}/1-90/${keccak256(stringToHex(text))}.json`;
  const recent = { fromBlock: 91n, toBlock: 100n, swaps: [], events: [{ id: "orphan", block: 99, blockHash: hash(99), logIndex: 0, tx: hash(999), kind: "BUY" as const }] };
  s.histories[token] = { parts: [{ from: 1n, to: 90n, path }], recent };
  let ranges = 0;
  const client = new SnapshotClient("https://data.invalid", async (url) => {
    if (String(url).endsWith("latest.json")) return new Response(stringifyData(s));
    ranges++; return new Response(text);
  });
  await client.refresh(); assert.equal((await client.history(token, s.block)).events.length, 1);
  s.block = head(100, 1); s.market.blockHash = s.block.hash; s.histories[token].recent.events = [];
  await client.refresh(); assert.equal((await client.history(token, s.block)).events.length, 0);
  assert.equal(ranges, 1);
});

test("mainnet histories reject another chain's path and corrupted content", async () => {
  const token = address(1), s = sample();
  const frozen = { fromBlock: 1n, toBlock: 90n, events: [], swaps: [] };
  const text = stringifyData(frozen), digest = keccak256(stringToHex(text));
  const part = { from: 1n, to: 90n, path: `/data/sepolia/history/${token}/1-90/${digest}.json` };
  s.histories[token] = { parts: [part], recent: { ...frozen, fromBlock: 91n, toBlock: 100n } };
  let requests = 0;
  const client = new SnapshotClient("https://data.invalid", async () => { requests++; return new Response(`${text} `); });
  await assert.rejects(client.history(token, s.block, s), /Invalid history path/);
  assert.equal(requests, 0);
  part.path = part.path.replace("/sepolia/", "/mainnet/");
  await assert.rejects(client.history(token, s.block, s), /content hash mismatch/);
  assert.equal(requests, 1);
});

test("visitor RPC uses a session, falls back on 429 and outages, and skips unsupported methods", async () => {
  let now = 0, requests = 0, fallbacks = 0;
  let status = 429, token: string | null = "signed";
  const request = createRelayRequest({ url: "https://data.invalid", now: () => now, token: () => token,
    fallback: async () => { fallbacks++; return "public"; }, request: async (_, init) => {
      requests++; assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer signed");
      return new Response(JSON.stringify({ result: "relay" }), { status });
    } });
  assert.equal(await request({ method: "eth_call", params: [] }), "public");
  assert.equal(await request({ method: "eth_call", params: [] }), "public"); assert.equal(requests, 1);
  now = 60_000; status = 200;
  assert.equal(await request({ method: "eth_call", params: [] }), "relay");
  assert.equal(await request({ method: "eth_getBlockByNumber", params: [] }), "public");
  token = null; assert.equal(await request({ method: "eth_call", params: [] }), "public");
  assert.equal(fallbacks, 4); assert.equal(requests, 2);
  const offline = createRelayRequest({ url: "https://data.invalid", token: () => "signed", request: async () => { throw Error("offline"); }, fallback: async () => "public" });
  assert.equal(await offline({ method: "eth_call" }), "public");
});

test("relay preserves contract reverts instead of retrying them through the public RPC", async () => {
  const request = createRelayRequest({ url: "https://data.invalid", token: () => "signed", fallback: async () => { throw Error("must not retry"); },
    request: async () => Response.json({ error: { code: 3, message: "Contract reverted.", data: "0x1234" } }) });
  await assert.rejects(request({ method: "eth_call" }), { code: 3 });
});

test("the default snapshot client calls fetch with its global receiver, never as a method", async () => {
  // A browser throws "Illegal invocation" when fetch is called with any other receiver, so the
  // shared-data mode silently fell back to the public RPC without ever reaching the Worker.
  const original = globalThis.fetch;
  const receivers: unknown[] = [];
  globalThis.fetch = function (this: unknown) {
    receivers.push(this);
    return Promise.resolve(new Response(stringifyData(sample()), { headers: { "Content-Type": "application/json" } }));
  } as unknown as typeof fetch;
  try {
    const client = new SnapshotClient("https://data.test.invalid");
    await client.refresh();
    assert.equal(receivers.length, 1);
    assert.ok(receivers[0] === globalThis || receivers[0] === undefined,
      `fetch was called on ${Object.prototype.toString.call(receivers[0])} instead of the global object`);
  } finally { globalThis.fetch = original; }
});
