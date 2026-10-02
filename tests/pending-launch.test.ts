import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  clearPendingLaunch, matchesLaunch, parsePendingLaunches, PENDING_LAUNCHES, pendingLaunchKey, readPendingLaunches,
  recordLaunchHash, savePendingLaunch, type LaunchStore, type PendingLaunch,
} from "../src/chain/pendingLaunch.ts";
import { childHookAddress, hasHookFlags, mineHookSalt, predictChildToken } from "../src/chain/launchpad.ts";
import { address, config, context } from "./helpers.ts";

function memoryStore() {
  const rows = new Map<string, string>();
  const store: LaunchStore & { rows: Map<string, string> } = {
    rows,
    getItem: (key) => rows.get(key) ?? null,
    setItem: (key, value) => { rows.set(key, value); },
    removeItem: (key) => { rows.delete(key); },
  };
  return store;
}
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const alice = address(20);
const launch = (over: Partial<PendingLaunch> = {}): PendingLaunch => ({
  chainId: config.chainId, launcher: alice, name: "My token", symbol: "MTK", team: address(21),
  tokenSalt: salt(1), hookSalt: salt(2), token: address(22), hook: address(23), hash: null, at: 1_000, ...over,
});

test("a saved launch survives a reload and is reused only for the very same token", () => {
  const store = memoryStore();
  const saved = launch();
  savePendingLaunch(saved, store);
  assert.deepEqual(readPendingLaunches(config.chainId, alice, store), [saved]);
  const want = { chainId: config.chainId, launcher: alice, name: "My token", symbol: "MTK", team: saved.team };
  const back = readPendingLaunches(config.chainId, alice, store);
  assert.equal(matchesLaunch(back, want)?.tokenSalt, salt(1), "the same token reuses its salts");
  // A checksum difference is the same wallet; a different name, symbol, team, wallet or chain is another launch.
  assert.ok(matchesLaunch(back, { ...want, launcher: alice.toUpperCase() as Address }));
  assert.equal(matchesLaunch(back, { ...want, name: "My token 2" }), null);
  assert.equal(matchesLaunch(back, { ...want, symbol: "MTK2" }), null);
  assert.equal(matchesLaunch(back, { ...want, team: address(99) }), null);
  assert.deepEqual(readPendingLaunches(config.chainId, address(98), store), [], "another wallet reads nothing of this one");
  assert.deepEqual(readPendingLaunches(11155111, alice, store), [], "another chain reads nothing of this one");
  assert.deepEqual(readPendingLaunches(config.chainId, null, store), [], "no wallet, no guard to read");
});

test("a second wallet, chain or token never erases another launch's guard", () => {
  const store = memoryStore();
  const mine = launch();
  savePendingLaunch(mine, store);
  savePendingLaunch(launch({ launcher: address(98), token: address(97) }), store);
  savePendingLaunch(launch({ chainId: 11155111, token: address(96) }), store);
  savePendingLaunch(launch({ name: "Other", symbol: "OTH", tokenSalt: salt(3), token: address(95) }), store);
  assert.deepEqual(readPendingLaunches(config.chainId, alice, store).map((p) => p.tokenSalt), [salt(3), salt(1)]);
  assert.equal(readPendingLaunches(config.chainId, address(98), store).length, 1);
  assert.equal(readPendingLaunches(11155111, alice, store).length, 1);
  // A new attempt at the same token replaces its own row instead of piling up.
  savePendingLaunch({ ...mine, hookSalt: salt(9) }, store);
  const rows = readPendingLaunches(config.chainId, alice, store);
  assert.equal(rows.length, 2);
  assert.equal(matchesLaunch(rows, mine)?.hookSalt, salt(9));
  // Older launches fall off the end rather than growing without bound.
  for (let i = 0; i < PENDING_LAUNCHES + 2; i++) {
    savePendingLaunch(launch({ name: `Token ${i}`, symbol: `T${i}`, tokenSalt: salt(100 + i) }), store);
  }
  assert.equal(readPendingLaunches(config.chainId, alice, store).length, PENDING_LAUNCHES);
  clearPendingLaunch(mine, store);
  assert.equal(matchesLaunch(readPendingLaunches(config.chainId, alice, store), mine), null);
});

test("the hash is recorded as soon as the wallet returns it, and cleared on success", () => {
  const store = memoryStore();
  const mine = launch();
  savePendingLaunch(mine, store);
  savePendingLaunch(launch({ name: "Other", symbol: "OTH", tokenSalt: salt(3) }), store);
  const hash = keccak256(stringToHex("sent"));
  recordLaunchHash(mine, hash, store, 5_000);
  const saved = matchesLaunch(readPendingLaunches(config.chainId, alice, store), mine);
  assert.equal(saved?.hash, hash);
  assert.equal(saved?.at, 5_000, "the banner dates the send, not the preparation");
  recordLaunchHash({ ...mine, launcher: address(98) }, keccak256(stringToHex("elsewhere")), store);
  assert.equal(matchesLaunch(readPendingLaunches(config.chainId, alice, store), mine)?.hash, hash);
  clearPendingLaunch(mine, store);
  assert.equal(matchesLaunch(readPendingLaunches(config.chainId, alice, store), mine), null);
  assert.equal(readPendingLaunches(config.chainId, alice, store).length, 1, "the other launch keeps waiting");
});

test("unreadable, truncated or foreign storage is treated as no launch at all", () => {
  assert.deepEqual(parsePendingLaunches(null, config.chainId, alice), []);
  assert.deepEqual(parsePendingLaunches("{", config.chainId, alice), []);
  assert.deepEqual(parsePendingLaunches(JSON.stringify(launch()), config.chainId, alice), [], "a bare object is not a list");
  const rows = (...values: unknown[]) => JSON.stringify(values);
  assert.deepEqual(parsePendingLaunches(rows({ ...launch(), tokenSalt: "0x1234" }), config.chainId, alice), []);
  assert.deepEqual(parsePendingLaunches(rows({ ...launch(), launcher: "not an address" }), config.chainId, alice), []);
  assert.deepEqual(parsePendingLaunches(rows({ ...launch(), at: "yesterday" }), config.chainId, alice), []);
  // A row moved to another wallet's or chain's key is not that launcher's guard.
  assert.deepEqual(parsePendingLaunches(rows(launch({ launcher: address(98) })), config.chainId, alice), []);
  assert.deepEqual(parsePendingLaunches(rows(launch()), 11155111, alice), []);
  // One broken row never hides the others.
  assert.equal(parsePendingLaunches(rows({ nonsense: true }, launch()), config.chainId, alice).length, 1);
  // A launch prepared but never mined or sent is still valid: its salts are what matter, and older builds may
  // simply have written fewer keys.
  const fresh = parsePendingLaunches(rows({ ...launch(), hookSalt: null, token: null, hook: null }), config.chainId, alice);
  assert.equal(fresh[0]?.tokenSalt, salt(1));
  assert.equal(fresh[0]?.hookSalt, null);
  const { hookSalt: _h, hash: _s, ...older } = launch();
  assert.equal(parsePendingLaunches(rows(older), config.chainId, alice)[0]?.hookSalt, null);
  const throwing: LaunchStore = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.deepEqual(readPendingLaunches(config.chainId, alice, throwing), []);
  savePendingLaunch(launch(), throwing);
  clearPendingLaunch(launch(), throwing);
  assert.equal(pendingLaunchKey(config.chainId, alice.toUpperCase() as Address), pendingLaunchKey(config.chainId, alice));
});

test("reusing the saved salts predicts the same token, and the saved hook salt is checked against the flags", async () => {
  const initCodeHash = keccak256(stringToHex("child init code"));
  let codeReads = 0;
  const ctx = context({ getCode: async () => { codeReads++; return "0x"; } });
  const mined = await mineHookSalt(ctx, config.forge, alice, initCodeHash);
  assert.ok(hasHookFlags(mined.hook), "the mined address carries the six hook flags");
  assert.equal(codeReads, 1);
  // What the app does on a second attempt: recompute the address from the saved salt instead of mining again.
  assert.equal(childHookAddress(config.forge, alice, mined.salt, initCodeHash), mined.hook);
  assert.ok(hasHookFlags(childHookAddress(config.forge, alice, mined.salt, initCodeHash)));
  // A Forge whose template or launch valuation changed gives another init code hash: the saved salt no longer
  // qualifies, so the app mines again rather than sending a hook its own constructor would reject.
  const other = childHookAddress(config.forge, alice, mined.salt, keccak256(stringToHex("other template")));
  assert.equal(hasHookFlags(other), false);
  // The token address depends only on the launcher and the salt, so a second attempt collides with the first.
  const token = predictChildToken(config.forge, alice, salt(1), "My token", "MTK");
  assert.equal(predictChildToken(config.forge, alice, salt(1), "My token", "MTK"), token);
  assert.notEqual(predictChildToken(config.forge, address(98), salt(1), "My token", "MTK"), token);
});
