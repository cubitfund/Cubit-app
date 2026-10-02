export type RpcFailure = "rate" | "quota" | "range" | "deterministic" | "outage";
type Failure = { status?: number; code?: number; message?: string; details?: string; name?: string; cause?: unknown };

/** Provider wrappers differ; classify the entire cause chain, with specific refusals before HTTP status. */
export function classifyRpcError(error: unknown): RpcFailure {
  const chain: Failure[] = [];
  for (let e = error; e && typeof e === "object" && chain.length < 10; e = (e as Failure).cause) chain.push(e as Failure);
  const text = chain.map((e) => `${e.message ?? ""} ${e.details ?? ""}`).join(" ");
  // Before "range": its message says "block range", but halving it cannot help, the upper half still holding
  // the block the lagging node does not know yet.
  if (isHeadLag(error)) return "outage";
  if (/quota|credits? exhausted|monthly limit|daily limit|payment required|billing/i.test(text) || chain.some((e) => e.status === 402)) return "quota";
  if (/block range|range.*(large|limit|exceed)|too many (results|logs)|response size|query returned more|limit.*\d+.*blocks/i.test(text)
    || chain.some((e) => e.status === 413 || e.code === -32614)) return "range";
  if (/rate limit|too many requests|requests? per second|request limit/i.test(text)
    || chain.some((e) => e.status === 429 || e.code === -32007)) return "rate";
  if (/execution reverted|invalid (argument|param)|method not found/i.test(text)
    || chain.some((e) => [3, 4001, -32600, -32601, -32602].includes(e.code ?? 0))) return "deterministic";
  // -32005 alone means "limit exceeded", not necessarily a throughput limit. Do not halve blindly.
  if (chain.some((e) => e.code === -32005)) return "range";
  return "outage";
}

/** A load-balanced endpoint answers from several nodes, one of which can still be a block behind the head a
 * read is pinned to. Its refusal may carry a deterministic code (-32602) but describes a transient lag. */
export function isHeadLag(error: unknown): boolean {
  for (let e = error, i = 0; e && typeof e === "object" && i < 10; e = (e as Failure).cause, i++) {
    const f = e as Failure;
    if (/beyond current head|block not found|header not found|unknown block/i.test(`${f.message ?? ""} ${f.details ?? ""}`)) return true;
  }
  return false;
}

/** Retry a read refused by a lagging node, a short delay apart; any other failure is returned at once. */
export async function withHeadLagRetry<T>(
  run: () => Promise<T>, retries = 2, delayMs = 1_500,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await run(); } catch (error) {
      if (attempt >= retries || !isHeadLag(error)) throw error;
      await sleep(delayMs);
    }
  }
}
