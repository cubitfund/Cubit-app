import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayDemand } from "../src/chain/relayDemand.ts";
import { startTurnstile, type Turnstile } from "../src/chain/turnstile.ts";
import { clearSession, sessionToken } from "../src/chain/relaySession.ts";
import { deferred } from "./helpers.ts";

function browser() {
  const scripts: Script[] = [], widgets: string[] = [], removed: string[] = [];
  let renderOptions: Record<string, unknown> = {}, api: Turnstile | undefined;
  class Script extends EventTarget {
    dataset: Record<string, string> = {}; src = ""; async = false;
    remove() { const index = scripts.indexOf(this); if (index >= 0) scripts.splice(index, 1); }
  }
  const document = Object.assign(new EventTarget(), {
    hidden: false, querySelector: () => scripts[0] ?? null,
    createElement: () => new Script(), head: { appendChild: (script: Script) => scripts.push(script) },
  });
  const options = { document: document as unknown as Document, api: () => api, container: {} as HTMLElement,
    siteKey: "FAKE_SITE_KEY", dataUrl: "https://data.invalid" };
  return { document, scripts, widgets, removed, options,
    rendered: () => renderOptions,
    load() {
      api = {
        render: (_, value) => { renderOptions = value; const id = `widget-${widgets.length}`; widgets.push(id); return id; },
        remove: (id) => removed.push(id), reset: () => {},
      };
      scripts[0]?.dispatchEvent(new Event("load"));
    },
    callback: (token: string) => (renderOptions.callback as (token: string) => Promise<void>)(token),
  };
}

test("public-only pages do not load Turnstile; nested visitor consumers share and clean up one widget", (t) => {
  clearSession(); t.after(clearSession);
  const b = browser(), demand = new RelayDemand(); let stop: (() => void) | null = null;
  const subscription = demand.subscribe(() => {
    if (demand.getSnapshot() && !stop) stop = startTurnstile({ ...b.options, error: assert.fail });
    if (!demand.getSnapshot() && stop) { stop(); stop = null; }
  });
  t.after(() => { stop?.(); subscription(); });
  assert.equal(demand.getSnapshot(), false); assert.equal(b.scripts.length, 0);
  const launchpad = demand.acquire(), swapPanel = demand.acquire();
  assert.equal(b.scripts.length, 1);
  b.load(); assert.equal(b.widgets.length, 1);
  assert.equal(b.rendered().appearance, "interaction-only");
  assert.equal(b.rendered()["refresh-expired"], "manual");
  launchpad(); launchpad(); assert.equal(demand.getSnapshot(), true); assert.equal(b.removed.length, 0);
  swapPanel(); assert.equal(demand.getSnapshot(), false);
  assert.equal(b.scripts.length, 0); assert.deepEqual(b.removed, ["widget-0"]);
  const vault = demand.acquire(); assert.equal(b.widgets.length, 2, "the loaded API can be reused on another visitor page");
  vault(); assert.deepEqual(b.removed, ["widget-0", "widget-1"]);
});

test("hidden visitor pages defer the script and verification errors keep the public fallback signal", async (t) => {
  clearSession(); t.after(clearSession);
  const b = browser(), errors: boolean[] = []; let requests = 0;
  b.document.hidden = true;
  const stop = startTurnstile({ ...b.options, error: (failed) => errors.push(failed),
    request: async () => { requests++; return new Response(null, { status: 403 }); } });
  t.after(stop);
  assert.equal(b.scripts.length, 0);
  b.document.hidden = false; b.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(b.scripts.length, 1);
  b.scripts[0].dispatchEvent(new Event("error")); assert.deepEqual(errors, [true]);
  b.load(); await b.callback("turnstile-token");
  assert.equal(requests, 1); assert.equal(sessionToken(), null); assert.deepEqual(errors, [true, true]);
  b.document.hidden = true; await b.callback("another-token"); assert.equal(requests, 1);
});

test("leaving the last visitor page aborts session creation and ignores late responses and callbacks", async (t) => {
  clearSession(); t.after(clearSession);
  const b = browser(), pending = deferred<Response>(); let signal: AbortSignal | undefined, requests = 0;
  const errors: boolean[] = [];
  const stop = startTurnstile({ ...b.options, error: (failed) => errors.push(failed), request: async (_, init) => {
    requests++; signal = init?.signal as AbortSignal; return pending.promise;
  } });
  b.load(); const reply = b.callback("turnstile-token");
  stop(); assert.equal(signal?.aborted, true); assert.equal(b.scripts.length, 0);
  pending.resolve(Response.json({ token: "signed", expiresAt: Date.now() + 1_800_000 })); await reply;
  await b.callback("late-token");
  assert.equal(sessionToken(), null); assert.equal(requests, 1); assert.deepEqual(errors, []);
});

test("a valid session avoids loading or renewing Turnstile until another session is needed", async (t) => {
  clearSession(); t.after(clearSession);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const b = browser(); let requests = 0;
  const options = { ...b.options, error: (failed: boolean) => assert.equal(failed, false), request: async () => {
    requests++; return Response.json({ token: "signed", expiresAt: Date.now() + 1_800_000 });
  } };
  const stop = startTurnstile(options); b.load(); await b.callback("turnstile-token");
  assert.equal(sessionToken(), "signed"); assert.equal(requests, 1);
  await b.callback("automatic-refresh"); assert.equal(requests, 1);
  stop();
  const next = browser();
  const stopNext = startTurnstile({ ...options, ...next.options }); t.after(stopNext);
  assert.equal(next.scripts.length, 0);
  t.mock.timers.tick(1_800_000); assert.equal(next.scripts.length, 1);
  next.load(); await next.callback("renewal"); assert.equal(requests, 2);
  stopNext(); t.mock.timers.tick(3_600_000);
  assert.equal(requests, 2); assert.equal(next.scripts.length, 0);
});
