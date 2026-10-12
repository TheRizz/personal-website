import type { Owner } from "./admin-auth";
import { jsonError, methodNotAllowed } from "./api";

// The admin router. index.ts mounts it behind `requireOwner`, so it only ever sees requests from
// the owner on an exact admin path; no route here checks access itself.

/** Every admin API route. Later steps add theirs, and the route-auth test walks this table. */
export const ADMIN_API_ROUTES = [{ method: "GET", path: "/api/admin/me" }] as const;

/** Admin page paths (client-rendered from Step 10.3), also walked by the route-auth test. */
export const ADMIN_PAGES = ["/admin", "/admin/drafts/example", "/admin/posts/example"] as const;

/**
 * Marks a browser that has signed in, so public pages probe /api/admin/me only for it. It is a
 * hint, not a credential: anyone can set it, and it costs them one failed probe.
 */
const OWNER_HINT_COOKIE = "owner_hint=1; Path=/; Max-Age=86400; Secure; SameSite=Lax";

/** Routes an owner request: /api/admin/* here, admin pages to React Router (`renderPage`). */
export async function handleAdmin(
  request: Request,
  owner: Owner,
  renderPage: () => Promise<Response>,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/")) return renderPage();

  if (pathname === "/api/admin/me") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
    return Response.json({ email: owner.email }, { headers: { "Set-Cookie": OWNER_HINT_COOKIE } });
  }
  return jsonError(404, "not_found", "No such API route.");
}
