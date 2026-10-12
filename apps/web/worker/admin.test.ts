import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminFetch } from "../app/lib/admin/api";
import { ADMIN_API_ROUTES, ADMIN_PAGES } from "./admin";
import worker from "./index";

// Every request below goes through the Worker's real fetch(), so the gate is proven to run before
// API dispatch and React Router. Rendering a page must never be reached without a valid token.
const render = vi.hoisted(() => vi.fn(async () => new Response("rendered page")));
vi.mock("virtual:react-router/server-build", () => ({}));
vi.mock("react-router", () => ({ createRequestHandler: () => render }));

const SITE = "https://ry-mart.com";
const TEAM = "https://route-table.cloudflareaccess.com";
const AUD = "route-table-aud";
let token: string;
let env: Env;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [jwk] })),
  );
  token = await new SignJWT({ aud: [AUD], email: "owner@example.com", type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(TEAM)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  env = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    OWNER_EMAIL: "owner@example.com",
  } as unknown as Env;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const ctx = {} as ExecutionContext;
const fetchWorker = (request: Request) =>
  worker.fetch(request as Parameters<typeof worker.fetch>[0], env, ctx);

const routes = [
  ...ADMIN_API_ROUTES,
  ...ADMIN_PAGES.map((path) => ({ method: "GET", path })),
  // Unknown admin API paths and bare /api/admin are behind the gate too.
  { method: "GET", path: "/api/admin" },
  { method: "GET", path: "/api/admin/unknown" },
  { method: "POST", path: "/api/admin/unknown" },
];

/** A request that passes every check except, without `token`, the Access assertion. */
function adminRequest(method: string, path: string, assertion?: string) {
  const headers: Record<string, string> = {
    Origin: SITE,
    "Sec-Fetch-Site": "same-origin",
    "X-Admin": "1",
    "Content-Type": "application/json",
  };
  if (assertion) headers["Cf-Access-Jwt-Assertion"] = assertion;
  const body = method === "GET" || method === "HEAD" ? undefined : "{}";
  return new Request(`${SITE}${path}`, { method, headers, body });
}

describe("admin route table", () => {
  it.each(routes)("$method $path is 404 without a token", async ({ method, path }) => {
    render.mockClear();
    const response = await fetchWorker(adminRequest(method, path));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(render).not.toHaveBeenCalled();
  });

  it.each(routes)("$method $path is 404 with a forged token", async ({ method, path }) => {
    const forged = `${token.slice(0, -4)}AAAA`;
    const response = await fetchWorker(adminRequest(method, path, forged));
    expect(response.status).toBe(404);
  });

  it("GET /api/admin/me returns the owner's e-mail and sets owner_hint", async () => {
    const response = await fetchWorker(adminRequest("GET", "/api/admin/me", token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "owner@example.com" });
    expect(response.headers.get("Set-Cookie")).toMatch(/^owner_hint=1; Path=\/;.*Secure/);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("admin pages reach React Router only with a valid token", async () => {
    render.mockClear();
    const response = await fetchWorker(adminRequest("GET", "/admin", token));
    expect(await response.text()).toBe("rendered page");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(render).toHaveBeenCalledOnce();
  });

  it("other admin API paths are 404 even for the owner", async () => {
    const response = await fetchWorker(adminRequest("GET", "/api/admin/nope", token));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("the admin fetch wrapper", () => {
  /**
   * Runs `send` as the owner's browser on ry-mart.com would: Access adds the token, the browser
   * adds Origin and Sec-Fetch-Site to a same-origin write, and the real Worker answers.
   */
  async function inBrowser(send: () => Promise<Response>): Promise<Response> {
    const keysFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      // The gate's own request for the Access keys.
      if (!input.startsWith("/")) return keysFetch(input, init);
      const headers = new Headers(init.headers);
      headers.set("Cf-Access-Jwt-Assertion", token);
      headers.set("Origin", SITE);
      headers.set("Sec-Fetch-Site", "same-origin");
      return fetchWorker(new Request(new URL(input, SITE), { ...init, headers }));
    });
    try {
      return await send();
    } finally {
      vi.stubGlobal("fetch", keysFetch);
    }
  }

  it("gets a write past the gate, and the same write without it is 404", async () => {
    const write = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    // Past the gate, /api/admin/me itself answers: it only allows GET.
    const wrapped = await inBrowser(() => adminFetch("/api/admin/me", write));
    expect(wrapped.status).toBe(405);
    expect(wrapped.headers.get("Allow")).toBe("GET");
    const plain = await inBrowser(() => fetch("/api/admin/me", write));
    expect(plain.status).toBe(404);
  });
});

describe("content security policy", () => {
  // The Worker skips the CSP on the dev server, whose HMR scripts carry no nonce.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const policyOf = async (request: Request) => {
    vi.stubEnv("DEV", false);
    return (await fetchWorker(request)).headers.get("Content-Security-Policy") ?? "";
  };

  it("admin pages get the admin policy with this response's nonce", async () => {
    render.mockClear();
    const policy = await policyOf(adminRequest("GET", "/admin", token));
    expect(policy).toMatch(/^default-src 'self'; script-src 'self' 'nonce-[\w+/=]+' /);
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("frame-ancestors 'none'");
    // The nonce reaches React Router, which puts it on its inline scripts.
    const nonce = /'nonce-([^']+)'/.exec(policy)![1];
    expect(render).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cspNonce: nonce }),
    );
  });

  it("refusals on admin paths get the admin policy too", async () => {
    const policy = await policyOf(adminRequest("GET", "/admin"));
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("public pages keep the site-wide policy", async () => {
    const policy = await policyOf(new Request(`${SITE}/games/tictactoe/ABCDEF`));
    expect(policy).toContain("connect-src 'self' wss://ry-mart.com");
    expect(policy).not.toContain("'wasm-unsafe-eval'");
  });
});
