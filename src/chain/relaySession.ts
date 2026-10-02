// Session stays in this tab's memory. It is never logged or saved in localStorage.
let session: { token: string; expiresAt: number } | null = null;
export const sessionToken = () => session && session.expiresAt > Date.now() + 5_000 ? session.token : null;
export const clearSession = () => { session = null; };
export function saveSession(value: { token: string; expiresAt: number }) {
  if (typeof value.token !== "string" || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error("Invalid relay session.");
  session = value;
}
