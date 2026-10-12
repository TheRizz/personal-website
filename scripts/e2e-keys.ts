/**
 * Sets up the e2e test identity (design doc §4.9.9). Run it before `pnpm build`: the Vite plugin
 * copies `.dev.vars` into the build, and `vite preview` reads that copy.
 *
 * - `e2e/.auth/access-identity.json` (gitignored): the private key that signs test tokens, plus
 *   the issuer, audience and e-mail they carry. Kept between runs, so a build stays valid.
 * - `apps/web/.dev.vars` (gitignored): the public key as ACCESS_TEST_JWKS, and matching Access
 *   settings. The Worker honours the key on localhost only and refuses all admin anywhere else.
 *
 * Production never sees either file: deploy.yml doesn't run this, and `wrangler deploy` never
 * uploads `.dev.vars`.
 */
import type { webcrypto } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const identityFile = new URL("e2e/.auth/access-identity.json", root);
const devVarsFile = new URL("apps/web/.dev.vars", root);

/** Also read by e2e/access.ts, which signs the test tokens. */
interface TestIdentity {
  kid: string;
  privateKey: webcrypto.JsonWebKey;
  publicKey: webcrypto.JsonWebKey;
  issuer: string;
  audience: string;
  email: string;
}

async function createIdentity(): Promise<TestIdentity> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const audience = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  return {
    kid: "e2e-test-key",
    privateKey: await crypto.subtle.exportKey("jwk", privateKey),
    publicKey: await crypto.subtle.exportKey("jwk", publicKey),
    issuer: "https://e2e-test.cloudflareaccess.com",
    audience,
    email: "owner@e2e.test",
  };
}

const identity: TestIdentity = existsSync(identityFile)
  ? (JSON.parse(await readFile(identityFile, "utf8")) as TestIdentity)
  : await createIdentity();
await mkdir(new URL(".", identityFile), { recursive: true });
await writeFile(identityFile, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });

const { kty, n, e } = identity.publicKey;
const jwks = JSON.stringify({ keys: [{ kty, n, e, kid: identity.kid, alg: "RS256", use: "sig" }] });
const vars: Record<string, string> = {
  ACCESS_TEST_JWKS: jwks,
  ACCESS_TEAM_DOMAIN: identity.issuer,
  ACCESS_AUD: identity.audience,
  OWNER_EMAIL: identity.email,
};

// Keep any other local vars the developer has set.
const existing = existsSync(devVarsFile) ? await readFile(devVarsFile, "utf8") : "";
const kept = existing
  .split("\n")
  .filter((line) => line.trim() && !Object.keys(vars).some((key) => line.startsWith(`${key}=`)));
const lines = Object.entries(vars).map(([key, value]) => `${key}='${value}'`);
await writeFile(devVarsFile, `${[...kept, ...lines].join("\n")}\n`, { mode: 0o600 });

console.log(`e2e test identity ready: ${fileURLToPath(identityFile)}`);
