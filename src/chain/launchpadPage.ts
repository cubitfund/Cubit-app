import { sameAddress } from "./address.ts";
import type { ChildLaunch } from "./launchpad.ts";

export const CHILD_ROWS = 12;

/** Canonical data wins; the provisional launch goes last to lead the newest-first page. */
export function mergeLaunchpadLaunches(launches: readonly ChildLaunch[], justLaunched: ChildLaunch | null) {
  const provisional = justLaunched && !launches.some((c) => sameAddress(c.hook, justLaunched.hook)) ? justLaunched : null;
  return { launches: provisional ? [...launches, provisional] : launches, justLaunched: provisional };
}

/** Visible hooks only select canonical rows; provisional rows never become read targets. */
export function launchpadReadTargets(launches: readonly ChildLaunch[], visibleHooks: readonly string[], selected: string | null) {
  const visible = new Set(visibleHooks.map((hook) => hook.toLowerCase()));
  const tokens = launches.filter((c) => visible.has(c.hook.toLowerCase())).reverse();
  const child = selected ? launches.find((c) => sameAddress(c.hook, selected)) ?? null : tokens[0] ?? null;
  const markets = child && !tokens.some((c) => sameAddress(c.hook, child.hook)) ? [...tokens, child] : tokens;
  return { tokens, child, markets };
}

/** One page shared by the launch table and governance reads; launches arrive oldest first. */
export function launchpadPage<T>(launches: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(launches.length / CHILD_ROWS));
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  const end = launches.length - page * CHILD_ROWS;
  const tokens = launches.slice(Math.max(0, end - CHILD_ROWS), end).reverse();
  return { page, pageCount, tokens };
}
