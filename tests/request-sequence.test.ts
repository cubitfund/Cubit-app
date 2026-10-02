import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestSequence } from "../src/chain/requestSequence.ts";
import { deferred } from "./helpers.ts";

test("an older quote finishing last cannot overwrite the newer quote or renew its TTL", async () => {
  const sequence = new RequestSequence();
  const first = deferred<string>();
  const second = deferred<string>();
  let quote = "";
  const load = async (pending: Promise<string>) => {
    const id = sequence.begin();
    const value = await pending;
    if (sequence.current(id)) quote = value;
  };
  const a = load(first.promise); const b = load(second.promise);
  second.resolve("new"); await b;
  first.resolve("old"); await a;
  assert.equal(quote, "new");
  const stale = sequence.begin(); sequence.invalidate();
  assert.equal(sequence.current(stale), false);
});
