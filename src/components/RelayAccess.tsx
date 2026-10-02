import { useEffect, useRef, useSyncExternalStore } from "react";
import { CONFIG } from "../chain/config";
import { dataClient } from "../chain/appChain";
import { relayDemand } from "../chain/relayDemand";
import { startTurnstile, type Turnstile } from "../chain/turnstile";

declare global { interface Window { turnstile?: Turnstile } }

/** Keep one instance for all mounted consumers; unmount completely on public-only pages. */
export function RelayAccess() {
  const active = useSyncExternalStore(relayDemand.subscribe, relayDemand.getSnapshot, () => false);
  return active && dataClient && CONFIG.turnstileSiteKey ? <SessionWidget /> : null;
}

function SessionWidget() {
  const container = useRef<HTMLDivElement>(null);
  // A failed challenge shows nothing: protected reads then use the app's direct transport.
  useEffect(() => startTurnstile({ document, api: () => window.turnstile, container: container.current!,
    dataUrl: CONFIG.dataUrl, siteKey: CONFIG.turnstileSiteKey, error: () => undefined }), []);
  return <div className="mx-auto max-w-[1400px] px-4 font-mono text-xs md:px-8">
    <div ref={container} aria-label="Verification for protected reads" />
  </div>;
}
