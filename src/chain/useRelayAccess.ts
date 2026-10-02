import { useEffect } from "react";
import { relayDemand } from "./relayDemand";

/** Only components which perform visitor-specific reads request a Turnstile session. */
export function useRelayAccess(enabled = true) {
  useEffect(() => { if (enabled) return relayDemand.acquire(); }, [enabled]);
}
