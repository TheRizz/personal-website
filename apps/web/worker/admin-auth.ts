import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { SITE_ORIGIN } from "./security-headers";

// The owner gate (design doc §4.9.1, ADR-0004). It runs first for every request that reaches the
// Worker. Every refusal is a bare 404, so no refusal says which check failed. It is not the site's
// HTML 404, so a gated path can be told from an unknown one; that is fine, because the admin
// routes are public in the repo and Access answers /admin anyway (ADR-0004).

/** The Access session duration (hosting guide §2.7). Older tokens are refused. */
const MAX_TOKEN_AGE = "24h";
const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";
const TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
/** Admin paths, matched against the canonical form of a path (see `classifyPath`). */
const ADMIN_PATH = /^\/(?:api\/)?admin(?:\/|$)/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const READ_METHODS = new Set(["GET", "HEAD"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Headers on every admin response, refusals included. */
export const ADMIN_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, private",
  "X-Robots-Tag": "noindex",
  "X-Frame-Options": "DENY",
};

/**
 * The bindings the gate reads. The team domain and AUD tag are plain vars; OWNER_EMAIL is a
 * secret. ACCESS_TEST_JWKS only ever comes from the gitignored `.dev.vars` that `pnpm e2e:keys`
 * writes, and is honoured on localhost only.
 */
export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
  ACCESS_TEST_JWKS?: string;
}

/** A request that passed the gate. */
export interface Owner {
  email: string;
}

export interface VerifyOptions {
  /** Resolves the signing key for a token header (the team's key set). */
  keys: JWTVerifyGetKey;
  /** `https://<team>.cloudflareaccess.com`, the token issuer. */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  ownerEmail: string;
  currentDate?: Date;
}

/** The team's signing keys could not be fetched. The gate answers 503 and lets nothing through. */
export class AccessKeysUnavailable extends Error {}

/**
 * Verifies a Cloudflare Access application token: RS256 only, exact issuer and audience, at most
 * 24 hours old, `type: "app"`, and the owner's e-mail (ignoring case). Throws on any failure.
 */
export async function verifyAccessJwt(token: string, options: VerifyOptions): Promise<Owner> {
  const { payload } = await jwtVerify(token, options.keys, {
    algorithms: ["RS256"],
    issuer: options.teamDomain,
    audience: options.audience,
    maxTokenAge: MAX_TOKEN_AGE,
    requiredClaims: ["exp", "iat"],
    clockTolerance: 30,
    currentDate: options.currentDate,
  });
  if (payload.type !== "app") throw new Error("Not an application token");
  const { email } = payload;
  if (
    typeof email !== "string" ||
    email.toLowerCase() !== options.ownerEmail.trim().toLowerCase()
  ) {
    throw new Error("Not the owner");
  }
  return { email };
}

/**
 * Whether a raw URL path is an admin path ("admin"), another spelling of one ("variant"), or
 * neither (null). The canonical form is percent-decoded, lowercase, with `//` collapsed and a
 * trailing `.data` removed, because React Router serves `/ADMIN`, `/%61dmin` and `/admin.data`
 * from admin routes. Throws URIError on malformed percent-encoding.
 */
export function classifyPath(rawPath: string): "admin" | "variant" | null {
  let decoded = decodeURIComponent(rawPath);
  // Decode again in case a later layer does: `%2561dmin` must not slip through either.
  for (let round = 0; round < 2 && decoded.includes("%"); round++) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  const canonical = decoded
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/\.data$/, "");
  if (!ADMIN_PATH.test(canonical)) return null;
  return canonical === rawPath ? "admin" : "variant";
}

/**
 * The owner gate. Returns null for a non-admin request, the owner for an admin request that
 * passed every check, and otherwise the refusal to send: 404 (any failure), 503 (Access keys
 * unreachable) or 400 (a path that can't be decoded, admin or not).
 */
export async function requireOwner(
  request: Request,
  env: AccessEnv,
): Promise<Owner | Response | null> {
  const url = new URL(request.url);
  let kind: ReturnType<typeof classifyPath>;
  try {
    kind = classifyPath(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (kind === null) return null;

  const isApi = url.pathname.toLowerCase().startsWith("/api/");
  // Logs the reason only: never the token, and never the path (it can hold draft or image ids).
  const refuse = (reason: string) => {
    console.warn("Admin request refused:", reason);
    return notFound(isApi);
  };
  if (kind === "variant") return refuse("non-canonical path");

  const testKeys = env.ACCESS_TEST_JWKS;
  if (testKeys && !LOCAL_HOSTS.has(url.hostname)) {
    console.error(`ALERT: the e2e test key is configured on ${url.hostname}; refusing all admin`);
    return notFound(isApi);
  }
  const siteOrigin = testKeys ? url.origin : SITE_ORIGIN;
  if (url.origin !== siteOrigin) return refuse("wrong host");

  const teamDomain = env.ACCESS_TEAM_DOMAIN ?? "";
  const audience = env.ACCESS_AUD ?? "";
  const ownerEmail = env.OWNER_EMAIL?.trim() ?? "";
  if (!TEAM_DOMAIN.test(teamDomain) || !audience || !ownerEmail) return refuse("not configured");

  if (WRITE_METHODS.has(request.method)) {
    if (!isSameOriginWrite(request, siteOrigin)) return refuse("cross-site write");
  } else if (!READ_METHODS.has(request.method)) {
    return refuse("method");
  }

  // Header only: the CF_Authorization cookie is whatever the client sends, so it is never read.
  const token = request.headers.get(ASSERTION_HEADER);
  if (!token) return refuse("no Access assertion header");
  try {
    const keys = testKeys ? localKeys(testKeys) : accessKeys(teamDomain);
    return await verifyAccessJwt(token, { keys, teamDomain, audience, ownerEmail });
  } catch (error) {
    if (error instanceof AccessKeysUnavailable) {
      console.error("Admin request refused: Access keys unavailable:", error.message);
      return withAdminHeaders(new Response("Service unavailable", { status: 503 }));
    }
    return refuse(
      `invalid token (${error instanceof errors.JOSEError ? error.code : String(error)})`,
    );
  }
}

/**
 * CSRF rules for writes: the site's own Origin, `Sec-Fetch-Site: same-origin` when sent, the
 * `X-Admin: 1` header (so a cross-site request needs a preflight), and a JSON body (raw image
 * bytes on uploads). DELETE has no body.
 */
function isSameOriginWrite(request: Request, siteOrigin: string): boolean {
  const { headers } = request;
  if (headers.get("Origin") !== siteOrigin) return false;
  const fetchSite = headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  if (headers.get("X-Admin") !== "1") return false;
  if (request.method === "DELETE") return true;
  const mediaType = headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "application/json") return true;
  const isUpload =
    request.method === "PUT" && new URL(request.url).pathname.startsWith("/api/admin/images/");
  return isUpload && mediaType.startsWith("image/");
}

/** Adds the admin headers (no caching, no indexing, no framing) to a response. */
export function withAdminHeaders(response: Response): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(ADMIN_HEADERS)) result.headers.set(name, value);
  return result;
}

/**
 * A bare 404: JSON under /api, plain text for pages. It differs from the site's HTML 404, which is
 * fine because the admin routes are public in the repo and Access answers /admin anyway.
 */
function notFound(isApi: boolean): Response {
  return withAdminHeaders(
    isApi
      ? Response.json(
          { error: { code: "not_found", message: "No such API route." } },
          { status: 404 },
        )
      : new Response("Not found", { status: 404 }),
  );
}

// Key sets are built once per isolate. The remote set caches the team's keys and refetches on an
// unknown `kid` (with a cooldown).
const remoteKeySets = new Map<string, JWTVerifyGetKey>();
const localKeySets = new Map<string, JWTVerifyGetKey>();

/** The team's keys from `<team>/cdn-cgi/access/certs`. A failed fetch is AccessKeysUnavailable. */
function accessKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(teamDomain);
  if (!keys) {
    const remote = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    keys = async (header, token) => {
      try {
        return await remote(header, token);
      } catch (error) {
        // No key for this `kid` is the token's fault (a 404); anything else is a fetch problem.
        if (error instanceof errors.JWKSNoMatchingKey) throw error;
        if (error instanceof errors.JWKSMultipleMatchingKeys) throw error;
        throw new AccessKeysUnavailable(error instanceof Error ? error.message : String(error));
      }
    };
    remoteKeySets.set(teamDomain, keys);
  }
  return keys;
}

/** The e2e test identity's public keys. Malformed JSON throws, which refuses the request. */
function localKeys(jwks: string): JWTVerifyGetKey {
  let keys = localKeySets.get(jwks);
  if (!keys) {
    keys = createLocalJWKSet(JSON.parse(jwks) as JSONWebKeySet);
    localKeySets.set(jwks, keys);
  }
  return keys;
}
