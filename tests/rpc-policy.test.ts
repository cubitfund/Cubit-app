import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcPolicy, MAX_RATE, OUTAGE_PAUSE_MS, QUOTA_PAUSE_MS, MAX_QUOTA_PAUSE_MS } from "../src/chain/rpcPolicy.ts";

function fixture() {
  let now = 100_000;
  const policy = new RpcPolicy(() => now);
  const send = () => { const r = policy.route(); assert.equal(policy.start(r), 0); return r; };
  return { policy, send, advance: (ms: number) => { now += ms; } };
}

test("burst counts actual starts in a sliding second, including late wakeups", () => {
  const { policy: p, advance } = fixture();
  const tickets = Array.from({ length: 200 }, () => p.route());
  assert.equal(tickets.filter((r) => r.endpoint === "private").length, 100);
  assert.equal(tickets.slice(0, 50).filter((r) => p.start(r) === 0).length, 50);
  for (const r of tickets.slice(50, 100)) assert.equal(p.start(r), 1_000);
  advance(999);
  assert.equal(p.start(tickets[50]), 1);
  advance(201); // timers wake 200 ms late: the next sliding window starts at dispatch, not reservation.
  for (const r of tickets.slice(50, 100)) assert.equal(p.start(r), 0);
  const next = p.route();
  advance(800);
  assert.equal(p.start(next), 200);
});

test("halving revises previously admitted slots and sends excess tickets public", () => {
  const { policy: p, send, advance } = fixture();
  const sent = Array.from({ length: 50 }, send);
  const waiting = Array.from({ length: 50 }, () => p.route());
  p.rateLimited(sent[0]);
  assert.equal(p.rate, 25);
  advance(1_000);
  for (const r of waiting.slice(0, 25)) assert.equal(p.start(r), 0);
  for (const r of waiting.slice(25)) assert.equal(p.start(r), null);
});

test("halving uses dispatched requests, not reservations; at most once per second", () => {
  const { policy: p, send, advance } = fixture();
  const sent = Array.from({ length: 12 }, send);
  Array.from({ length: 80 }, () => p.route());
  p.rateLimited(sent[0]);
  assert.equal(p.rate, 6);
  p.rateLimited(sent[1]);
  assert.equal(p.rate, 6);
  advance(2_000);
  const r = send();
  p.rateLimited(r);
  assert.equal(p.rate, 1);
  advance(1_000);
  p.rateLimited(send());
  assert.equal(p.rate, 1);
});

test("outage invalidates waiting slots, pauses 30 s, then admits exactly one probe", () => {
  const { policy: p, send, advance } = fixture();
  const failed = send();
  const waiting = p.route();
  p.failed(failed);
  assert.equal(p.start(waiting), null);
  advance(OUTAGE_PAUSE_MS - 1);
  assert.equal(p.route().endpoint, "public");
  advance(1);
  const probe = send();
  assert.equal(probe.endpoint === "private" && probe.probe, true);
  assert.equal(p.route().endpoint, "public");
  p.answered(failed); // stale response cannot reopen the circuit
  assert.equal(p.route().endpoint, "public");
  p.answered(probe);
  send();
});

test("failed probe pauses again; a range refusal ends a successful connectivity probe", () => {
  const { policy: p, send, advance } = fixture();
  p.failed(send());
  advance(OUTAGE_PAUSE_MS);
  p.failed(send());
  advance(OUTAGE_PAUSE_MS - 1);
  assert.equal(p.route().endpoint, "public");
  advance(1);
  p.refused(send());
  send();
  assert.equal(p.rate, MAX_RATE);
});

test("quiet answers increase once a second, capped at 50", () => {
  const { policy: p, send, advance } = fixture();
  const r = send();
  p.rateLimited(r);
  p.answered(r);
  assert.equal(p.rate, 1);
  for (let i = 0; i < 60; i++) {
    advance(1_000);
    const reply = send();
    p.answered(reply);
    p.answered(reply);
    assert.equal(p.rate, Math.min(50, i + 2));
  }
});

test("two equally busy visitors converge under a shared, symmetric throughput refusal", () => {
  let now = 100_000;
  const visitors = [new RpcPolicy(() => now), new RpcPolicy(() => now)];
  visitors[1].rate = 5;
  for (let s = 0; s < 180; s++) {
    now += 1_000;
    const requests = visitors.map((p) => Array.from({ length: Math.min(40, p.rate) }, () => {
      const r = p.route(); assert.equal(p.start(r), 0); return r;
    }));
    const congested = requests.flat().length > 50;
    visitors.forEach((p, i) => congested ? p.rateLimited(requests[i][0]) : p.answered(requests[i][0]));
  }
  assert.ok(Math.abs(visitors[0].rate - visitors[1].rate) <= 2);
});

test("quota exhaustion backs off from 30 seconds to five minutes with one probe, then resets on recovery", () => {
  const { policy: p, send, advance } = fixture();
  let attempt = send();
  const stale = attempt;
  const waiting = p.route();
  for (const pause of [QUOTA_PAUSE_MS, 60_000, 120_000, 240_000, MAX_QUOTA_PAUSE_MS, MAX_QUOTA_PAUSE_MS]) {
    p.quotaExceeded(attempt);
    p.answered(stale); // A late success from before the quota refusal cannot reset this epoch.
    assert.equal(p.start(waiting), null);
    assert.equal(p.rate, MAX_RATE, "quota refusals do not halve throughput");
    assert.equal(p.route().endpoint, "public");
    advance(pause - 1);
    assert.equal(p.route().endpoint, "public");
    advance(1);
    attempt = send();
    assert.equal(attempt.endpoint === "private" && attempt.probe, true);
    assert.equal(p.route().endpoint, "public", "one quota probe at a time");
  }
  p.answered(attempt);
  p.quotaExceeded(send());
  advance(QUOTA_PAUSE_MS - 1);
  assert.equal(p.route().endpoint, "public");
  advance(1);
  send(); // Recovery reset the next quota delay to 30 seconds.
});

test("a network failure during quota recovery keeps the network delay at 30 seconds", () => {
  const { policy: p, send, advance } = fixture();
  p.quotaExceeded(send()); advance(QUOTA_PAUSE_MS);
  p.quotaExceeded(send()); advance(60_000);
  p.failed(send());
  advance(OUTAGE_PAUSE_MS - 1); assert.equal(p.route().endpoint, "public");
  advance(1);
  p.quotaExceeded(send()); // A timeout is not a usable response and does not reset the quota streak.
  advance(120_000 - 1); assert.equal(p.route().endpoint, "public");
  advance(1); send();
});

for (const reply of ["refused", "rateLimited"] as const) test(`a ${reply} response resets quota backoff`, () => {
  const { policy: p, send, advance } = fixture();
  p.quotaExceeded(send()); advance(QUOTA_PAUSE_MS);
  p.quotaExceeded(send()); advance(60_000);
  p[reply](send());
  advance(1_000); // A throughput response may have reduced the rate to 1/s.
  p.quotaExceeded(send());
  advance(QUOTA_PAUSE_MS - 1); assert.equal(p.route().endpoint, "public");
  advance(1); send();
});
