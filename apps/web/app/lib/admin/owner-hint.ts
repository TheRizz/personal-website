// The owner hint (design doc §4.9.1): a cookie that only says this browser has signed in, so public
// pages probe /api/admin/me for it alone. It is not a credential. The Worker sets it on
// GET /api/admin/me, and signing out clears it.

/** The hint cookie's name. */
export const OWNER_HINT_COOKIE = "owner_hint";

/** Where "Sign out" goes: Cloudflare Access ends the session and revokes its token. */
export const SIGN_OUT_PATH = "/cdn-cgi/access/logout";

/**
 * True when a `document.cookie` string holds the hint, `owner_hint=1`, as one whole cookie. Any
 * other value, or the text inside another cookie's value, doesn't count.
 */
export function hasOwnerHint(cookie: string): boolean {
  return cookie.split(";").some((piece) => piece.trim() === `${OWNER_HINT_COOKIE}=1`);
}

/** Deletes the owner hint (same path and attributes it was set with). */
export function clearOwnerHint(): void {
  document.cookie = `${OWNER_HINT_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
}
