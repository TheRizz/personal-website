import { createRequestHandler } from "react-router";
import { handleApi } from "./api";

export { GameLobby } from "./game-lobby";

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

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      return Response.json({ ok: true, version: __APP_VERSION__ }, { headers: noStore });
    }
    if (pathname.startsWith("/api/")) return handleApi(request, env);

    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<Env>;
