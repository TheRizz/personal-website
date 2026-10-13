import { useSyncExternalStore } from "react";

// Every request the admin pages make to /api/admin/* goes through `adminFetch` (design doc
// §4.9.1). The owner gate refuses any write without its headers, so a forged cross-site form or
// a plain fetch() can't change anything.

const ADMIN_API = "/api/admin/";

let sessionExpired = false;
const listeners = new Set<() => void>();

/**
 * fetch() for /api/admin/* with the headers the owner gate needs:
 * - `X-Requested-With: XMLHttpRequest`, so Access answers an expired session with 401 instead of
 *   a redirect to its login page.
 * - `X-Admin: 1`, required on every write (a cross-site request can't add it without a
 *   preflight, which Access refuses).
 *
 * A string body is sent as JSON unless the caller sets a Content-Type. A 401, or a redirect
 * (Access sending the browser to sign in), marks the session expired (`isSessionExpired`).
 */
export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith(ADMIN_API)) throw new Error(`adminFetch is for ${ADMIN_API}* only`);
  const headers = new Headers(init.headers);
  headers.set("X-Requested-With", "XMLHttpRequest");
  headers.set("X-Admin", "1");
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, redirect: "manual" });
  if (response.status === 401 || response.type === "opaqueredirect") markSessionExpired();
  return response;
}

/**
 * Marks the Access session expired and tells subscribers. `adminFetch` calls it on a 401; image
 * uploads, which use XMLHttpRequest for progress, call it themselves.
 */
export function markSessionExpired() {
  if (sessionExpired) return;
  sessionExpired = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True once any admin request found the Access session expired. It stays true until a reload. */
export function isSessionExpired(): boolean {
  return sessionExpired;
}

/** `isSessionExpired` for components; always false while rendering on the server. */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, isSessionExpired, () => false);
}
