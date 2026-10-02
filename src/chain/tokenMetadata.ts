import type { Address } from "viem";
import type { CursorStore } from "./logCursor.ts";

/** Constructor-only metadata, coalesced in memory. Failed reads never poison the cache. */
export function createMetadataCache(store?: CursorStore) {
  const values = new Map<string, Promise<{ name: string; symbol: string }>>();
  return {
    read(chainId: number, token: Address, load: () => Promise<{ name: string; symbol: string }>, incarnation = "") {
      const key = `${chainId}:${token.toLowerCase()}:${incarnation}`;
      const cached = values.get(key);
      if (cached) return cached;
      const read = async () => {
        const saved = await store!.get<{ name: string; symbol: string }>(`metadata:${key}`);
        if (saved) return saved;
        const value = await load(); await store!.put(`metadata:${key}`, value); return value;
      };
      const pending = (store ? read() : load()).catch((e) => { if (values.get(key) === pending) values.delete(key); throw e; });
      values.set(key, pending);
      return pending;
    },
    // A launch removed by a reorg can be deployed again at the same address on the replacement branch.
    forget(chainId: number, token: Address) {
      for (const key of values.keys()) if (key.startsWith(`${chainId}:${token.toLowerCase()}:`)) values.delete(key);
    },
  };
}
