import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  classifyPath,
  requireOwner,
  verifyAccessJwt,
  type AccessEnv,
  type VerifyOptions,
} from "./admin-auth";

const OWNER = "Owner@Example.com";
const AUD = "0123456789abcdef";
const SITE = "https://ry-mart.com";
const HOUR = 3600;

let privateKey: CryptoKey;
let publicJwk: JWK;
let options: VerifyOptions;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  options = {
    keys: createLocalJWKSet({ keys: [publicJwk] }),
    teamDomain: "https://team.cloudflareaccess.com",
    audience: AUD,
    ownerEmail: OWNER,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const now = () => Math.floor(Date.now() / 1000);

/** An Access application token for the owner; `claims` override or (as undefined) remove claims. */
function sign(claims: JWTPayload = {}, issuer = options.teamDomain): Promise<string> {
  const payload: JWTPayload = {
    aud: [AUD],
    email: "owner@example.com",
    type: "app",
    iat: now(),
    exp: now() + HOUR,
    iss: issuer,
    sub: "user-id",
    ...claims,
  };
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(privateKey);
}

describe("verifyAccessJwt", () => {
  it("accepts the owner's application token, ignoring e-mail case", async () => {
    expect(await verifyAccessJwt(await sign(), options)).toEqual({ email: "owner@example.com" });
  });

  it.each<[string, JWTPayload]>([
    ["wrong audience", { aud: ["someone-else"] }],
    ["wrong issuer", { iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { iat: now() - 2 * HOUR, exp: now() - 120 }],
    ["older than the session", { iat: now() - 25 * HOUR, exp: now() + HOUR }],
    ["issued in the future", { iat: now() + 600 }],
    ["missing iat", { iat: undefined }],
    ["wrong e-mail", { email: "visitor@example.com" }],
    ["no e-mail", { email: undefined }],
    ["an org token, not an app token", { type: "org" }],
  ])("refuses a token that is %s", async (_, claims) => {
    await expect(verifyAccessJwt(await sign(claims), options)).rejects.toThrow();
  });

  it("refuses HS256 signed with the public key (algorithm confusion)", async () => {
    const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
    const token = await new SignJWT({
      aud: [AUD],
      email: OWNER,
      type: "app",
      iss: options.teamDomain,
    })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    await expect(verifyAccessJwt(token, options)).rejects.toThrow(/alg/);
  });

  it("refuses a token signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    const token = await new SignJWT({
      aud: [AUD],
      email: OWNER,
      type: "app",
      iss: options.teamDomain,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(other.privateKey);
    await expect(verifyAccessJwt(token, options)).rejects.toThrow();
  });
});

describe("classifyPath", () => {
  it.each([
    ["/admin", "admin"],
    ["/admin/", "admin"],
    ["/admin/drafts/abc123", "admin"],
    ["/api/admin", "admin"],
    ["/api/admin/me", "admin"],
    ["/ADMIN", "variant"],
    ["/ADMIN/", "variant"],
    ["/Admin/drafts", "variant"],
    ["/%61dmin", "variant"],
    ["/%2561dmin", "variant"],
    ["/admin%2Fdrafts", "variant"],
    ["/admin.data", "variant"],
    ["/admin/drafts/x.data", "variant"],
    ["//admin", "variant"],
    ["/api//admin/me", "variant"],
    ["/API/ADMIN/me", "variant"],
    ["/%61pi/admin/me", "variant"],
    ["/", null],
    ["/administrator", null],
    ["/blog/admin", null],
    ["/api/lobbies", null],
    ["/_root.data", null],
    ["/blog/100%25", null],
  ] as const)("%s is %s", (path, kind) => {
    expect(classifyPath(path)).toBe(kind);
  });

  it("throws on malformed percent-encoding", () => {
    expect(() => classifyPath("/admin/%E0%A4%A")).toThrow(URIError);
  });
});

/** Valid production config; the team's key set is served by a stubbed fetch. */
function prodEnv(teamDomain: string, overrides: AccessEnv = {}): AccessEnv {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${teamDomain}/cdn-cgi/access/certs`);
      return Response.json({ keys: [publicJwk] });
    }),
  );
  return { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER, ...overrides };
}

function request(path: string, init: RequestInit = {}, origin = SITE) {
  return new Request(`${origin}${path}`, init);
}

/** A same-origin write with every CSRF header the gate requires, plus `headers`. */
function write(path: string, token: string, headers: Record<string, string> = {}) {
  return request(path, {
    method: "POST",
    body: "{}",
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      Origin: SITE,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "X-Admin": "1",
      ...headers,
    },
  });
}

async function expectRefused(result: unknown, status = 404) {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
}

describe("requireOwner", () => {
  const team = (name: string) => `https://${name}.cloudflareaccess.com`;

  it("ignores non-admin paths", async () => {
    expect(await requireOwner(request("/blog/hello"), {})).toBeNull();
    expect(await requireOwner(request("/api/lobbies"), {})).toBeNull();
  });

  it("lets the owner through with a valid assertion header", async () => {
    const env = prodEnv(team("valid"));
    const token = await sign({}, env.ACCESS_TEAM_DOMAIN);
    const headers = { "Cf-Access-Jwt-Assertion": token };
    expect(await requireOwner(request("/api/admin/me", { headers }), env)).toEqual({
      email: "owner@example.com",
    });
    expect(await requireOwner(request("/admin", { headers }), env)).toEqual({
      email: "owner@example.com",
    });
  });

  it("refuses a valid token on any other spelling of an admin path", async () => {
    const env = prodEnv(team("variants"));
    const headers = { "Cf-Access-Jwt-Assertion": await sign({}, env.ACCESS_TEAM_DOMAIN) };
    for (const path of [
      "/ADMIN",
      "/ADMIN/",
      "/%61dmin",
      "/admin.data",
      "/API/ADMIN/me",
      "/%61pi/admin/me",
    ]) {
      await expectRefused(await requireOwner(request(path, { headers }), env));
    }
  });

  it("answers 400 for a path that can't be decoded", async () => {
    const result = await requireOwner(request("/admin/%E0%A4%A"), {});
    expect((result as Response).status).toBe(400);
  });

  it("refuses a valid token on another host", async () => {
    const env = prodEnv(team("hosts"));
    const headers = { "Cf-Access-Jwt-Assertion": await sign({}, env.ACCESS_TEAM_DOMAIN) };
    for (const origin of [
      "https://site.someone.workers.dev",
      "http://ry-mart.com",
      "https://www.ry-mart.com",
    ]) {
      await expectRefused(await requireOwner(request("/api/admin/me", { headers }, origin), env));
    }
  });

  it("never reads the CF_Authorization cookie", async () => {
    const env = prodEnv(team("cookie"));
    const token = await sign({}, env.ACCESS_TEAM_DOMAIN);
    const headers = { Cookie: `CF_Authorization=${token}` };
    await expectRefused(await requireOwner(request("/api/admin/me", { headers }), env));
  });

  it("refuses an invalid token without logging it", async () => {
    const env = prodEnv(team("logs"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = await sign({ email: "visitor@example.com" }, env.ACCESS_TEAM_DOMAIN);
    const headers = { "Cf-Access-Jwt-Assertion": token };
    await expectRefused(await requireOwner(request("/api/admin/me", { headers }), env));
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token.split(".")[2]);
  });

  it.each<[string, AccessEnv]>([
    ["no team domain", { ACCESS_TEAM_DOMAIN: "" }],
    ["a team domain that isn't Access", { ACCESS_TEAM_DOMAIN: "https://evil.example" }],
    ["no AUD tag", { ACCESS_AUD: "" }],
    ["no OWNER_EMAIL", { OWNER_EMAIL: undefined }],
  ])("fails closed with %s", async (_, overrides) => {
    const env = prodEnv(team("config"), overrides);
    const token = await sign({}, team("config"));
    const headers = { "Cf-Access-Jwt-Assertion": token };
    await expectRefused(await requireOwner(request("/api/admin/me", { headers }), env));
  });

  it("answers 503, not the request, when the team's keys can't be fetched", async () => {
    const teamDomain = team("down");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: AUD, OWNER_EMAIL: OWNER };
    const headers = { "Cf-Access-Jwt-Assertion": await sign({}, teamDomain) };
    await expectRefused(await requireOwner(request("/api/admin/me", { headers }), env), 503);
  });

  describe("writes", () => {
    it("pass with the site's Origin, same-origin fetch, JSON and X-Admin", async () => {
      const env = prodEnv(team("writes"));
      const token = await sign({}, env.ACCESS_TEAM_DOMAIN);
      expect(await requireOwner(write("/api/admin/drafts", token), env)).toEqual({
        email: "owner@example.com",
      });
      // Older browsers don't send Sec-Fetch-Site.
      const noFetchSite = write("/api/admin/drafts", token);
      noFetchSite.headers.delete("Sec-Fetch-Site");
      expect(await requireOwner(noFetchSite, env)).toEqual({ email: "owner@example.com" });
    });

    it.each<[string, Record<string, string>]>([
      ["a foreign Origin", { Origin: "https://evil.example" }],
      ["a null Origin", { Origin: "null" }],
      ["a cross-site Sec-Fetch-Site", { "Sec-Fetch-Site": "cross-site" }],
      ["a same-site Sec-Fetch-Site", { "Sec-Fetch-Site": "same-site" }],
      ["a form content type", { "Content-Type": "application/x-www-form-urlencoded" }],
      ["a text content type", { "Content-Type": "text/plain" }],
      ["an image outside the upload route", { "Content-Type": "image/png" }],
      ["no X-Admin header", { "X-Admin": "" }],
    ])("are refused with %s", async (_, headers) => {
      const env = prodEnv(team("csrf"));
      const token = await sign({}, env.ACCESS_TEAM_DOMAIN);
      await expectRefused(await requireOwner(write("/api/admin/drafts", token, headers), env));
    });

    it("are refused without an Origin", async () => {
      const env = prodEnv(team("origin"));
      const req = write("/api/admin/drafts", await sign({}, env.ACCESS_TEAM_DOMAIN));
      req.headers.delete("Origin");
      await expectRefused(await requireOwner(req, env));
    });

    it("accept image bytes only on an image upload", async () => {
      const env = prodEnv(team("upload"));
      const token = await sign({}, env.ACCESS_TEAM_DOMAIN);
      const upload = new Request(
        write("/api/admin/images/abc/800", token, { "Content-Type": "image/webp" }),
        {
          method: "PUT",
        },
      );
      expect(await requireOwner(upload, env)).toEqual({ email: "owner@example.com" });
    });
  });

  describe("the e2e test identity", () => {
    const testEnv = (): AccessEnv => ({
      ACCESS_TEAM_DOMAIN: team("e2e"),
      ACCESS_AUD: AUD,
      OWNER_EMAIL: OWNER,
      ACCESS_TEST_JWKS: JSON.stringify({ keys: [publicJwk] }),
    });

    it("is honoured on localhost", async () => {
      const headers = { "Cf-Access-Jwt-Assertion": await sign({}, team("e2e")) };
      const local = request("/api/admin/me", { headers }, "http://localhost:4173");
      expect(await requireOwner(local, testEnv())).toEqual({ email: "owner@example.com" });
    });

    it("refuses every admin request anywhere else", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const headers = { "Cf-Access-Jwt-Assertion": await sign({}, team("e2e")) };
      await expectRefused(await requireOwner(request("/api/admin/me", { headers }), testEnv()));
      expect(error).toHaveBeenCalledWith(expect.stringContaining("ALERT"));
    });
  });
});
