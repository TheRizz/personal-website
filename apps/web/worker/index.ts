import { createRequestHandler } from "react-router";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: { env: Env; ctx: ExecutionContext };
  }
}

declare const __APP_VERSION__: string;

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const noStore = { "Cache-Control": "no-store" };

/**
 * One instance per game lobby. Implemented in Phase 7 (design doc §4.5).
 * Written as a plain class rather than extending DurableObject from "cloudflare:workers",
 * because React Router prerenders pages by loading this module in Node.
 */
export class GameLobby implements DurableObject {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {}

  fetch(): Response {
    return new Response("Not implemented", { status: 501 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      return Response.json({ ok: true, version: __APP_VERSION__ }, { headers: noStore });
    }
    if (pathname.startsWith("/api/")) {
      return Response.json(
        { error: { code: "not_found", message: "No such API route." } },
        { status: 404, headers: noStore },
      );
    }

    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<Env>;
