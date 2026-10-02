import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { CubitForgeAbi } from "../src/chain/abi.ts";
import { confirmsChildLaunch } from "../src/chain/launchpad.ts";
import { address, hash } from "./helpers.ts";

const expected = { forge: address(0xabcdef), token: address(0xabc123), hook: address(0xdef456) };
type Receipt = Pick<TransactionReceipt, "status" | "logs">;
type ReceiptLog = Receipt["logs"][number];

function launchLog(overrides: Partial<typeof expected> = {}): ReceiptLog {
  const { forge, token, hook } = { ...expected, ...overrides };
  return {
    address: forge,
    topics: encodeEventTopics({ abi: CubitForgeAbi, eventName: "ChildLaunched", args: { token, hook, launcher: address(10) } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [address(11), 5_000_000_000_000_000n]),
    blockNumber: 100n, blockHash: hash(100), transactionHash: hash(101), transactionIndex: 0, logIndex: 0, removed: false,
  };
}

const receipt = (...logs: ReceiptLog[]): Receipt => ({ status: "success", logs });

test("a matching Forge ChildLaunched receipt confirms the prepared launch", () => {
  const unrelated = { ...launchLog(), topics: [hash(999)] as [Hex], data: "0x" as Hex };
  assert.equal(confirmsChildLaunch(receipt(unrelated, launchLog()), expected), true);
});

test("a successful wallet cancellation with no logs does not confirm a launch", () => {
  assert.equal(confirmsChildLaunch(receipt(), expected), false);
});

test("the token and hook must both match in the same ChildLaunched event", () => {
  const wrongToken = launchLog({ token: address(20) });
  const wrongHook = launchLog({ hook: address(21) });
  const wrongBoth = launchLog({ token: address(20), hook: address(21) });
  for (const logs of [[wrongToken], [wrongHook], [wrongBoth], [wrongToken, wrongHook]]) {
    assert.equal(confirmsChildLaunch(receipt(...logs), expected), false);
  }
});

test("matching ChildLaunched arguments from another emitter do not confirm a launch", () => {
  assert.equal(confirmsChildLaunch(receipt(launchLog({ forge: address(30) })), expected), false);
});

test("Forge, token and hook comparisons ignore address case", () => {
  const upper = (value: Address): Address => `0x${value.slice(2).toUpperCase()}`;
  assert.equal(confirmsChildLaunch(receipt(launchLog()), {
    forge: upper(expected.forge), token: upper(expected.token), hook: upper(expected.hook),
  }), true);
  assert.equal(confirmsChildLaunch(receipt(launchLog({ forge: upper(expected.forge) })), {
    forge: getAddress(expected.forge), token: getAddress(expected.token), hook: getAddress(expected.hook),
  }), true);
});

test("reverted receipts and incomplete ChildLaunched logs cannot confirm a launch", () => {
  assert.equal(confirmsChildLaunch({ ...receipt(launchLog()), status: "reverted" }, expected), false);
  assert.equal(confirmsChildLaunch(receipt({ ...launchLog(), data: "0x" }), expected), false);
  assert.equal(confirmsChildLaunch(receipt({ ...launchLog(), topics: launchLog().topics.slice(0, 2) as [Hex, ...Hex[]] }), expected), false);
});
