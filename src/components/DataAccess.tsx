import { useEffect, useState } from "react";
import { dataClient, publicData } from "../chain/appChain";
// Global data-source warning; visitor-session widgets have their own mounted-consumer scope.
export function DataAccess() {
  const [, update] = useState(0);
  useEffect(() => {
    if (!dataClient) return;
    const redraw = () => update((v) => v + 1);
    const stop = dataClient.subscribe(redraw);
    const stopSource = publicData.subscribe(redraw);
    return () => { stop(); stopSource(); };
  }, []);
  if (!dataClient || !publicData.warning) return null;
  const snapshot = dataClient.current;
  return <div className="mx-auto max-w-[1400px] px-4 pt-3 font-mono text-xs md:px-8">
    <p role="status" className="border-2 border-orange p-3 text-orange">
      {publicData.warning}
      {snapshot && ` · Last shared block ${snapshot.block.number} · Produced ${new Date(snapshot.producedAt).toLocaleTimeString()}`}
    </p>
  </div>;
}
