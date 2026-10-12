import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
