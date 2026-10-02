import assert from "node:assert/strict";
import { test } from "node:test";
import { createRelayRequest } from "../src/chain/relayRequest.ts";
import { PUBLIC_DEADLINE_MS } from "../src/chain/requestPool.ts";
import { flush } from "./helpers.ts";

const allowed = { method: "eth_blockNumber" };
const success = () => Response.json({ result: "relay" });

test("deterministic HTTP refusals use the public RPC only for the refused call", async () => {
  for (const status of [400, 403, 413, 415, 422]) {
    let requests = 0, fallbacks = 0;
    const refused = { method: "eth_call", params: [{ to: "0xdead", data: "0x1234" }] };
    const request = createRelayRequest({ url: "https://data.invalid", token: () => "signed", now: () => 0,
      clearToken: () => assert.fail("Deterministic refusals must keep the session"),
      request: async () => ++requests === 1 ? new Response(null, { status }) : success(),
      fallback: async (args) => { assert.deepEqual(args, refused); fallbacks++; return "public"; },
    });
    assert.equal(await request(refused), "public", `HTTP ${status}`);
    assert.equal(await request(allowed), "relay", `HTTP ${status} must not pause the next call`);
    assert.equal(requests, 2); assert.equal(fallbacks, 1);
  }
});

async function assertPause(first: () => Promise<Response>, duration: number) {
  let now = 0, requests = 0, fallbacks = 0;
  const request = createRelayRequest({ url: "https://data.invalid", token: () => "signed", now: () => now,
    clearToken: () => assert.fail("An outage or rate limit must keep the session"),
    request: async () => ++requests === 1 ? first() : success(),
    fallback: async () => { fallbacks++; return "public"; },
  });
  assert.equal(await request(allowed), "public");
  assert.equal(await request(allowed), "public");
  now = duration - 1;
  assert.equal(await request(allowed), "public");
  assert.equal(requests, 1); assert.equal(fallbacks, 3);
  now = duration;
  assert.equal(await request(allowed), "relay");
  assert.equal(requests, 2);
}

test("HTTP 429 pauses the relay for exactly 60 seconds", async () => {
  await assertPause(async () => new Response(null, { status: 429 }), 60_000);
});

test("server and network failures pause the relay for exactly 30 seconds", async () => {
  for (const status of [500, 502, 503, 504]) {
    await assertPause(async () => new Response(null, { status }), 30_000);
  }
  await assertPause(async () => { throw new TypeError("Network error"); }, 30_000);
});

test("a relay deadline falls back and pauses for 30 seconds from the timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0, requests = 0;
  let signal: AbortSignal | undefined;
  const request = createRelayRequest({ url: "https://data.invalid", token: () => "signed", now: () => now,
    request: async (_, init) => {
      if (++requests > 1) return success();
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    }, fallback: async () => "public",
  });
  const pending = request(allowed);
  await flush();
  now = PUBLIC_DEADLINE_MS;
  t.mock.timers.tick(PUBLIC_DEADLINE_MS);
  assert.equal(await pending, "public"); assert.equal(signal?.aborted, true);
  now += 29_999;
  assert.equal(await request(allowed), "public"); assert.equal(requests, 1);
  now++;
  assert.equal(await request(allowed), "relay"); assert.equal(requests, 2);
});

test("HTTP 401 clears the session and keeps the existing 30-second pause", async () => {
  let now = 0, requests = 0, cleared = 0;
  let token: string | null = "expired";
  const request = createRelayRequest({ url: "https://data.invalid", token: () => token, now: () => now,
    request: async () => ++requests === 1 ? new Response(null, { status: 401 }) : success(),
    clearToken: () => { cleared++; token = null; }, fallback: async () => "public",
  });
  assert.equal(await request(allowed), "public"); assert.equal(cleared, 1); assert.equal(token, null);
  assert.equal(await request(allowed), "public");
  token = "renewed"; now = 29_999;
  assert.equal(await request(allowed), "public"); assert.equal(requests, 1);
  now++;
  assert.equal(await request(allowed), "relay"); assert.equal(requests, 2);
});
