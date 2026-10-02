import { clearSession, saveSession, sessionToken } from "./relaySession.ts";

export type Turnstile = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
};

/** Called only while a visitor-read consumer is mounted. DOM/API injection keeps lifecycle tests offline. */
export function startTurnstile(options: {
  document: Document; api: () => Turnstile | undefined; container: HTMLElement;
  siteKey: string; dataUrl: string; error: (failed: boolean) => void; request?: typeof fetch;
}) {
  const { document, api } = options;
  let alive = true, widget: string | undefined, busy = false, resetAt = 0;
  const controller = new AbortController();
  const failed = () => { if (alive) { clearSession(); options.error(true); } };
  const mount = () => {
    if (!alive || document.hidden || !api() || widget !== undefined || sessionToken()) return;
    resetAt = Date.now();
    widget = api()!.render(options.container, {
      sitekey: options.siteKey, action: "rpc-session", theme: "light", appearance: "interaction-only",
      "refresh-expired": "manual",
      callback: async (token: string) => {
        if (!alive || document.hidden || busy || sessionToken()) return;
        busy = true;
        try {
          const r = await (options.request ?? fetch)(`${options.dataUrl}/session`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          });
          if (!r.ok) throw new Error("Session unavailable.");
          const value = await r.json();
          if (alive) { saveSession(value); options.error(false); }
        } catch { failed(); }
        finally { busy = false; }
      },
      "error-callback": failed,
    });
  };
  let script = document.querySelector<HTMLScriptElement>("script[data-cubit-turnstile]");
  const tick = () => {
    if (!alive || document.hidden || sessionToken()) return;
    if (!api() && !script) {
      script = document.createElement("script"); script.dataset.cubitTurnstile = "true";
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; script.async = true;
      script.addEventListener("load", mount); script.addEventListener("error", failed);
      document.head.appendChild(script);
    }
    mount();
    if (widget !== undefined && !busy && Date.now() - resetAt > 60_000) {
      resetAt = Date.now(); api()?.reset(widget);
    }
  };
  script?.addEventListener("load", mount); script?.addEventListener("error", failed);
  tick(); const timer = setInterval(tick, 30_000);
  document.addEventListener("visibilitychange", tick);
  return () => {
    if (!alive) return;
    alive = false; clearInterval(timer); controller.abort();
    script?.removeEventListener("load", mount); script?.removeEventListener("error", failed);
    document.removeEventListener("visibilitychange", tick);
    if (widget !== undefined) api()?.remove(widget);
    script?.remove();
  };
}
