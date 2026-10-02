// A hidden tab starts no new poll. Reads already in flight and receipt tracking continue; visibility resumes polling.
// Otherwise a tab forgotten in the background would spend the RPC quota all day.

export const tabHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** Calls `onVisible` each time the tab is shown again; returns the function that stops listening. */
export function onTabVisible(onVisible: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const listener = () => {
    if (!tabHidden()) onVisible();
  };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
