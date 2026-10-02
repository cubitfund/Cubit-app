// The launchpad with launcher-chosen fees: buy → team, sell → team and sell → walls, within the Forge's bounds (the
// Forge accepts them since the launchpad v2). Released: /launchpad itself lets the launcher choose, and this address
// leads there. With CUSTOM_TAXES_PUBLIC false (launch.ts), visitors are sent to /launchpad and only
// `/launchpad-custom?preview` shows the page, which search engines are asked not to index.
import { useEffect } from "react";
import { Navigate, useLocation } from "react-router";
import { CUSTOM_TAXES_PUBLIC } from "../launch";
import { LaunchpadV2 } from "./LaunchpadV2";

export function LaunchpadCustom() {
  const preview = new URLSearchParams(useLocation().search).has("preview");
  useEffect(() => {
    if (CUSTOM_TAXES_PUBLIC) return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);
  if (CUSTOM_TAXES_PUBLIC || !preview) return <Navigate to="/launchpad" replace />;
  return <LaunchpadV2 chooseTaxes />;
}

/** /launchpad: CUBIT's rates until the custom-fees release, then the launcher's choice (launch.ts). */
export function LaunchpadMain() {
  return <LaunchpadV2 chooseTaxes={CUSTOM_TAXES_PUBLIC} />;
}
