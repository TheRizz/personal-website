import { OWNER_HINT_COOKIE } from "../app/lib/admin/owner-hint";
import type { Owner } from "./admin-auth";
import { jsonError, methodNotAllowed } from "./api";
import { handleDrafts } from "./drafts";
import { handleImages } from "./images";
import { handlePhotos } from "./photos";
import { handlePublishing } from "./publish";

// The admin router. index.ts mounts it behind `requireOwner`, so it only ever sees requests from
// the owner on an exact admin path; no route here checks access itself.

/** Every admin API route. Later steps add theirs, and the route-auth test walks this table. */
const DRAFT = "/api/admin/drafts/00000000-0000-4000-8000-000000000000";
const IMAGE = "/api/admin/images/00000000-0000-4000-8000-000000000000";
const PHOTO = "/api/admin/photos/00000000-0000-4000-8000-000000000000";
export const ADMIN_API_ROUTES = [
  { method: "GET", path: "/api/admin/me" },
  { method: "GET", path: "/api/admin/drafts" },
  { method: "POST", path: "/api/admin/drafts" },
  { method: "GET", path: DRAFT },
  { method: "PUT", path: DRAFT },
  { method: "DELETE", path: DRAFT },
  { method: "GET", path: `${DRAFT}/revisions` },
  { method: "POST", path: `${DRAFT}/revisions/1/restore` },
  { method: "POST", path: "/api/admin/images" },
  { method: "PUT", path: `${IMAGE}/480` },
  { method: "POST", path: "/api/admin/images/published" },
  { method: "POST", path: `${DRAFT}/publish` },
  { method: "GET", path: `${DRAFT}/status` },
  { method: "POST", path: `${DRAFT}/cancel` },
  { method: "GET", path: "/api/admin/posts" },
  { method: "POST", path: "/api/admin/posts/example/import" },
  { method: "POST", path: "/api/admin/posts/example/unpublish" },
  { method: "GET", path: "/api/admin/photos" },
  { method: "POST", path: "/api/admin/photos" },
  { method: "PUT", path: `${PHOTO}/480` },
  { method: "PATCH", path: PHOTO },
  { method: "DELETE", path: PHOTO },
] as const;

/** Admin page paths, also walked by the route-auth test. */
export const ADMIN_PAGES = [
  "/admin",
  "/admin/drafts/example",
  "/admin/posts/example",
  "/admin/photos",
] as const;

/**
 * Marks a browser that has signed in, so public pages probe /api/admin/me only for it. It is a
 * hint, not a credential: anyone can set it, and it costs them one failed probe.
 */
const OWNER_HINT = `${OWNER_HINT_COOKIE}=1; Path=/; Max-Age=86400; Secure; SameSite=Lax`;

/**
 * Routes an owner request: /api/admin/* here, admin pages to React Router (`renderPage`). `ctx`
 * lets publishing finish its GitHub and D1 writes even if the client goes away.
 */
export async function handleAdmin(
  request: Request,
  env: Env,
  owner: Owner,
  renderPage: () => Promise<Response>,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/")) return renderPage();

  if (pathname === "/api/admin/me") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
    return Response.json({ email: owner.email }, { headers: { "Set-Cookie": OWNER_HINT } });
  }
  const drafts = await handleDrafts(request, env);
  if (drafts) return drafts;
  const images = await handleImages(request, env);
  if (images) return images;
  const photos = await handlePhotos(request, env);
  if (photos) return photos;
  const publishing = await handlePublishing(request, env, ctx);
  if (publishing) return publishing;
  return jsonError(404, "not_found", "No such API route.");
}
