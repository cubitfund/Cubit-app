import { RelayAccess } from "./components/RelayAccess";
// Root — global layout. Owns the ONE live protocol store instance (useProtocolStore)
// and shares it with every child route via outlet context. Pages read it with useStore().
// Never call useProtocolStore() again inside a page — that would start a second store.
import { useEffect } from "react";
import { Outlet, useLocation, useOutletContext } from "react-router";
import { useProtocolStore, type ProtocolState } from "./store";
import { CONFIG, sameAddress } from "./chain/config";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { ComingSoon } from "./components/primitives";

export function Root() {
  const { pathname, hash, search } = useLocation();
  const token = new URLSearchParams(search).get("token");
  const showCubitHistory = pathname === "/" || pathname === "/proof" || (pathname === "/momentum" && (!token || sameAddress(token, CONFIG.token)));
  const store = useProtocolStore(showCubitHistory);

  // scroll to top on route change (but honour in-page hash links)
  useEffect(() => {
    if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);

  return (
    <div className="min-h-full bg-cream text-ink">
      <Header store={store} />
      <RelayAccess />
      <main>
        {store.marketOpen === false && (
          <div className="mx-auto max-w-[1400px] px-4 pt-8 md:px-8">
            <ComingSoon message="CUBIT contracts are deployed on Ethereum mainnet. The market is not open yet. Trading and market data will be available after launch." />
          </div>
        )}
        <Outlet context={store} />
      </main>
      <Footer />
    </div>
  );
}

// Shared protocol state for child routes — one live instance.
export function useStore() {
  return useOutletContext<ProtocolState>();
}
