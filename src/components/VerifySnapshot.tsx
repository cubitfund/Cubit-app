import { useState } from "react";
import { directPublicClient } from "../chain/client";
import { CONFIG } from "../chain/config";
import { verifySnapshot } from "../chain/verifySnapshot";
import type { MarketState } from "../chain/market";

export function VerifySnapshot({ market }: { market: MarketState | null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const verify = async () => {
    if (!market || busy) return;
    setBusy(true); setResult(null);
    try {
      const r = await verifySnapshot({ client: directPublicClient, config: CONFIG }, market);
      setResult(r.match ? `Verified block ${r.block} (${r.hash.slice(0, 12)}…): block hash and key figures match the public RPC.`
        : `Mismatch at block ${r.block}: ${r.differences.join(", ")}.`);
    } catch { setResult("Verification unavailable or block hash changed. Refresh and try again."); }
    finally { setBusy(false); }
  };
  return <div className="mb-6 font-mono text-xs">
    <button className="brutal brutal-lift bg-lime px-4 py-2 disabled:opacity-50" disabled={!market || busy} onClick={() => void verify()}>
      {busy ? "Verifying…" : "Verify on chain"}
    </button>
    <p className="mt-2 text-ink/65">Independent public RPC check of the block hash, price, Band, walls, registry, Lens and vault totals. History is not included.</p>
    {result && <p role="status" className="mt-2">{result}</p>}
  </div>;
}
