// Real Vite builds, entirely in memory, with fake endpoints and no network requests.
// Each case gets a fresh process because Vite also uses NODE_ENV during module loading.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const privateUrl = "https://private.invalid/PRIVATE_RPC_BUILD_SENTINEL";
const dataUrl = "https://shared.invalid";
// The app-only endpoint for reads the shared worker does not serve (VITE_FALLBACK_RPC_URL).
const fallbackUrl = "https://app-endpoint.invalid/APP_RPC_BUILD_SENTINEL";
const [sharing, mode] = process.argv.slice(2);

if (!sharing) {
  let cases = 0;
  for (const sharing of ["public", "direct", "shared", "fallback"]) {
    for (const mode of ["production", "development"]) {
      for (const nodeEnv of ["production", "development"]) {
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), sharing, mode], {
          cwd: root, stdio: "inherit",
          env: { ...process.env, NODE_ENV: nodeEnv, VITE_RPC_URL: sharing === "public" ? "" : privateUrl,
            VITE_DATA_URL: sharing === "shared" || sharing === "fallback" ? `${dataUrl}/` : "",
            VITE_FALLBACK_RPC_URL: sharing === "fallback" ? fallbackUrl : "", VITE_TURNSTILE_SITE_KEY: "FAKE_SITE_KEY" },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${sharing}, mode=${mode}, NODE_ENV=${nodeEnv}`);
        cases++;
      }
    }
  }
  console.log(`Build modes: ${cases}/${cases} passed (bundles, source maps, transport, wallet RPC and cross-origin data/session/relay).`);
} else {
  const shared = sharing === "shared" || sharing === "fallback";
  const override = sharing === "direct";
  const appEndpoint = sharing === "fallback";
  // Fail closed if a future build plugin attempts an HTTP request.
  globalThis.fetch = async () => { throw new Error("Network is forbidden in build-mode checks."); };
  const { build } = await import("vite");
  const result = await build({ root, mode, logLevel: "silent", build: { write: false, sourcemap: true } });
  let maps = 0, foundPrivate = false, foundFallback = false;
  for (const bundle of Array.isArray(result) ? result : [result]) {
    for (const output of bundle.output) {
      const texts = [JSON.stringify(output)];
      if (output.type === "chunk") {
        if (output.map) { maps++; texts.push(JSON.stringify(output.map)); }
        for (const match of output.code.matchAll(/sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/g)) {
          maps++; texts.push(Buffer.from(match[1], "base64").toString("utf8"));
        }
      }
      foundPrivate ||= texts.some((text) => text.includes(privateUrl));
      foundFallback ||= texts.some((text) => text.includes(fallbackUrl));
    }
  }
  assert.ok(maps > 0, "Source maps must also be inspected");
  assert.equal(foundPrivate, override, "Private endpoint must appear only with an explicit direct override");
  assert.equal(foundFallback, appEndpoint, "The app endpoint must appear only when the build names it");

  // Execute the actual built config/client, using the same Vite config and environment.
  const entry = resolve(root, "rpc-build-check.ts");
  const runtime = await build({ root, mode, logLevel: "silent", plugins: [{
    name: "rpc-build-check",
    resolveId: (id) => id === entry ? `\0${entry}` : undefined,
    load: (id) => id === `\0${entry}` ? `export { CONFIG } from ${JSON.stringify(resolve(root, "src/chain/config.ts"))};
      export { chain, publicClient, directPublicClient } from ${JSON.stringify(resolve(root, "src/chain/client.ts"))};
      export { SCHEMA_VERSION, SnapshotClient, stringifyData } from ${JSON.stringify(resolve(root, "src/chain/snapshot.ts"))};
      export { startTurnstile } from ${JSON.stringify(resolve(root, "src/chain/turnstile.ts"))};
      export { clearSession } from ${JSON.stringify(resolve(root, "src/chain/relaySession.ts"))};` : undefined,
  }], build: { write: false, sourcemap: false, lib: { entry, formats: ["es"], fileName: "rpc-build-check" },
    rolldownOptions: { output: { codeSplitting: false } } } });
  const outputs = (Array.isArray(runtime) ? runtime : [runtime]).flatMap((bundle) => bundle.output);
  const chunks = outputs.filter((output) => output.type === "chunk");
  assert.equal(chunks.length, 1, "Runtime check must be self-contained");
  const runtimeCode = `${chunks[0].code}\n//# sourceURL=rpc-build-check.mjs`;
  const built = await import(`data:text/javascript;base64,${Buffer.from(runtimeCode).toString("base64")}`)
    .catch((error) => { throw new Error(error.message); });
  const { CONFIG, chain, publicClient, directPublicClient } = built;
  assert.equal(CONFIG.dataUrl, shared ? dataUrl : "");
  assert.equal(CONFIG.rpcUrl, override ? privateUrl : CONFIG.publicRpcUrl);
  assert.equal(CONFIG.fallbackRpcUrl, appEndpoint ? fallbackUrl : CONFIG.publicRpcUrl);
  assert.equal(CONFIG.chainId, 1);
  assert.equal(chain.id, 1);
  assert.equal(CONFIG.explorer, "https://etherscan.io");
  assert.deepEqual(chain.rpcUrls, { default: { http: [CONFIG.publicRpcUrl] } });
  const publicUrl = new URL(CONFIG.publicRpcUrl).href;
  const calls = [];
  let failPrivate = false, failFallback = false;
  globalThis.fetch = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    calls.push(url);
    assert.ok(url === privateUrl || url === publicUrl || (appEndpoint && url === fallbackUrl), "Unexpected RPC endpoint");
    if (url === privateUrl && failPrivate) return new Response("Unavailable", { status: 503 });
    if (url === fallbackUrl && failFallback) return new Response("Unavailable", { status: 503 });
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
  };
  const rpcCall = () => publicClient.request({ method: "eth_chainId" })
    .catch((error) => { throw new Error(error.shortMessage || error.message); });
  await rpcCall();
  // Without a session, the relay falls back to the app endpoint when the build names one.
  assert.deepEqual(calls, [override ? privateUrl : appEndpoint ? fallbackUrl : publicUrl]);
  if (override) {
    failPrivate = true;
    await rpcCall();
    await rpcCall();
    assert.deepEqual(calls, [privateUrl, privateUrl, publicUrl, publicUrl],
      "Private endpoint failure must fall back and pause subsequent private calls");
  } else if (appEndpoint) {
    // Direct reads (history, block check) use the app endpoint, paced, and fall back to the public RPC.
    calls.length = 0;
    const directCall = () => directPublicClient.request({ method: "eth_chainId" })
      .catch((error) => { throw new Error(error.shortMessage || error.message); });
    await directCall();
    failFallback = true;
    await directCall();
    await directCall();
    assert.deepEqual(calls, [fallbackUrl, fallbackUrl, publicUrl, publicUrl],
      "App endpoint failure must fall back and pause subsequent app-endpoint calls");
  }
  console.log(`PASS ${sharing}, mode=${mode}, NODE_ENV=${process.env.NODE_ENV}`);
}
