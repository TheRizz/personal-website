import type { webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/** The e2e test identity written by `pnpm e2e:keys` (scripts/e2e-keys.ts, which imports this). */
export interface TestIdentity {
  kid: string;
  privateKey: webcrypto.JsonWebKey;
  publicKey: webcrypto.JsonWebKey;
  issuer: string;
  audience: string;
  email: string;
}

const IDENTITY_FILE = new URL(".auth/access-identity.json", import.meta.url);

/** The header Cloudflare Access puts its token in, and the only place the Worker reads it. */
export const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

export function testIdentity(): TestIdentity {
  if (!existsSync(IDENTITY_FILE)) {
    throw new Error("No e2e test identity: run `pnpm e2e:keys` before `pnpm build`.");
  }
  return JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) as TestIdentity;
}

const base64url = (data: string | ArrayBuffer) =>
  Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");

/** Signs an Access application token for the owner, like the one Access sends to the Worker. */
export async function signAccessToken(): Promise<string> {
  const identity = testIdentity();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: identity.kid, typ: "JWT" };
  const payload = {
    aud: [identity.audience],
    email: identity.email,
    exp: now + 3600,
    iat: now,
    nbf: now,
    iss: identity.issuer,
    type: "app",
    identity_nonce: "e2e",
    sub: "e2e-owner",
    country: "XX",
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    identity.privateKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(signature)}`;
}
