// Route table — the single source of truth for URLs.
// react-router v8 data mode. All pages render inside Root's <Outlet/> and receive the
// shared protocol store via outlet context (see Root.tsx / useStore()).
import { createBrowserRouter, Navigate } from "react-router";
import { Root } from "./Root";
import { Home } from "./pages/Home";
import { Proof } from "./pages/Proof";
import { Vault } from "./pages/Vault";
import { Momentum } from "./pages/Momentum";
import { Launchpad } from "./pages/Launchpad";
import { LaunchpadCustom, LaunchpadMain } from "./pages/LaunchpadCustom";
import { Roadmap } from "./pages/Roadmap";
import { CONFIG } from "./chain/config";
import { launchpadV2Configured } from "./chain/launchpadV2";

// /launchpad is the launchpad v2 wherever the build knows one; the first launchpad (its tokens and the governance
// vault panel) stays at /launchpad-v1.
const v2 = launchpadV2Configured(CONFIG);

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Root,
    children: [
      { index: true, Component: Home },
      { path: "proof", Component: Proof },
      { path: "vault", Component: Vault },
      { path: "momentum", Component: Momentum },
      { path: "launchpad", Component: v2 ? LaunchpadMain : Launchpad },
      { path: "launchpad-v1", Component: Launchpad },
      // Launcher-chosen fees: leads to /launchpad once released (CUSTOM_TAXES_PUBLIC in launch.ts).
      { path: "launchpad-custom", Component: LaunchpadCustom },
      { path: "launchpad-v2", element: <Navigate to="/launchpad" replace /> },
      { path: "roadmap", Component: Roadmap },
      // legacy links → redirects
      { path: "forge", element: <Navigate to="/launchpad" replace /> },
      { path: "activity", element: <Navigate to="/proof" replace /> },
      { path: "staking", element: <Navigate to="/vault" replace /> },
      { path: "keepers", element: <Navigate to="/vault" replace /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);
