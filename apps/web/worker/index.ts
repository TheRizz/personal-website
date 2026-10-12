import { createRequestHandler } from "react-router";
import { themeScript } from "../app/components/ThemeToggle";
import { handleAdmin } from "./admin";
import { requireOwner, withAdminHeaders } from "./admin-auth";
import { handleApi } from "./api";
import {
  SECURITY_HEADERS,
  adminContentSecurityPolicy,
  contentSecurityPolicy,
  createNonce,
  scriptHashSource,
} from "./security-headers";

export { GameLobby } from "./game-lobby";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: { env: Env; ctx: ExecutionContext };
    /** CSP nonce for this render's inline scripts. Absent while prerendering and in dev. */
    cspNonce?: string;
  }
}

declare const __APP_VERSION__: string;

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const noStore = { "Cache-Control": "no-store" };

// The theme script in root.tsx is allowed by its hash, so the layout needs no nonce.
let themeScriptHash: Promise<string> | undefined;

/**
 * Adds the security headers, with a CSP that allows only this response's nonce (and the theme):
 * the admin policy for anything on an admin path, the site-wide one for everything else. Exactly
 * one CSP header is sent, because two would both be enforced.
 */
async function withSecurityHeaders(
  request: Request,
  response: Response,
  nonce: string,
  admin: boolean,
) {
  // A WebSocket upgrade must be returned as it is.
  if (response.status === 101 || response.webSocket) return response;
  // The dev server injects inline scripts (HMR) that carry no nonce.
  if (import.meta.env.DEV) return response;

  const url = new URL(request.url);
  themeScriptHash ??= scriptHashSource(themeScript);
  const inlineScripts = [`'nonce-${nonce}'`, await themeScriptHash];
  const policy = admin
    ? adminContentSecurityPolicy({ inlineScripts })
    : contentSecurityPolicy({
        inlineScripts,
        socketOrigin: `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`,
      });
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) result.headers.set(name, value);
  result.headers.set("Content-Security-Policy", policy);
  return result;
}

async function route(request: Request, env: Env, renderPage: () => Promise<Response>) {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/health") {
    return Response.json({ ok: true, version: __APP_VERSION__ }, { headers: noStore });
  }
  if (pathname.startsWith("/api/")) return handleApi(request, env);
  return renderPage();
}

export default {
  async fetch(request, env, ctx) {
    const nonce = createNonce();
    // Dev sends no CSP (see withSecurityHeaders), so a nonce there would only break hydration.
    const cspNonce = import.meta.env.DEV ? undefined : nonce;
    const renderPage = () => requestHandler(request, { cloudflare: { env, ctx }, cspNonce });

    // The owner gate runs before anything else, so no admin path can be reached around it.
    const owner = await requireOwner(request, env);
    let response: Response;
    if (owner instanceof Response) response = owner;
    else if (owner) response = withAdminHeaders(await handleAdmin(request, owner, renderPage));
    else response = await route(request, env, renderPage);
    // `owner` is null only for a path that isn't admin; a refusal gets the admin policy too.
    return withSecurityHeaders(request, response, nonce, owner !== null);
  },
} satisfies ExportedHandler<Env>;
