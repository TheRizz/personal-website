/**
 * Sets up the e2e test identity and the test GitHub App (design doc §4.9.9). Run it before
 * `pnpm build`: the Vite plugin copies `.dev.vars` into the build, and `vite preview` reads that
 * copy.
 *
 * - `e2e/.auth/access-identity.json` (gitignored): the private key that signs test tokens, plus
 *   the issuer, audience and e-mail they carry. Kept between runs, so a build stays valid.
 * - `e2e/.auth/github-app.json` (gitignored): a throwaway App key pair. The Worker signs its App
 *   JWTs with the private key, and the GitHub stub (e2e/github-stub.ts) checks them with the
 *   public one. Kept between runs too.
 * - `apps/web/.dev.vars` (gitignored): the public key as ACCESS_TEST_JWKS, and matching Access
 *   settings. The Worker honours the key on localhost only and refuses all admin anywhere else.
 *   Also the test App and GITHUB_API_BASE, which points publishing at the stub; the Worker
 *   honours that on localhost only too.
 *
 * Production never sees any of these files: deploy.yml doesn't run this, and `wrangler deploy`
 * never uploads `.dev.vars`.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TestIdentity } from "../e2e/access";
import { GITHUB_APP_FILE, type TestGitHubApp } from "../e2e/github-stub/api";
import { githubStubPort } from "../e2e/github-stub-port";

const root = new URL("../", import.meta.url);
const identityFile = new URL("e2e/.auth/access-identity.json", root);
const devVarsFile = new URL("apps/web/.dev.vars", root);

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

/** A DER key as PEM: base64 in 64-column lines between the label's armour lines. */
function pem(label: string, der: ArrayBuffer): string {
  const lines =
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** A test App like the real one (hosting guide §2.10): an RS256 key, exported as PKCS#8. */
async function createGitHubApp(): Promise<TestGitHubApp> {
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
  return {
    clientId: "Iv-e2e-test",
    installationId: "4242",
    privateKeyPkcs8Pem: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", privateKey)),
    publicKeySpkiPem: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", publicKey)),
  };
}

const identity: TestIdentity = existsSync(identityFile)
  ? (JSON.parse(await readFile(identityFile, "utf8")) as TestIdentity)
  : await createIdentity();
await mkdir(new URL(".", identityFile), { recursive: true });
await writeFile(identityFile, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });

const app: TestGitHubApp = existsSync(GITHUB_APP_FILE)
  ? (JSON.parse(await readFile(GITHUB_APP_FILE, "utf8")) as TestGitHubApp)
  : await createGitHubApp();
await writeFile(GITHUB_APP_FILE, `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600 });

const { kty, n, e } = identity.publicKey;
const jwks = JSON.stringify({ keys: [{ kty, n, e, kid: identity.kid, alg: "RS256", use: "sig" }] });
const vars: Record<string, string> = {
  ACCESS_TEST_JWKS: jwks,
  ACCESS_TEAM_DOMAIN: identity.issuer,
  ACCESS_AUD: identity.audience,
  OWNER_EMAIL: identity.email,
  GITHUB_API_BASE: `http://127.0.0.1:${githubStubPort()}`,
  GITHUB_APP_CLIENT_ID: app.clientId,
  GITHUB_APP_INSTALLATION_ID: app.installationId,
  // One line: literal \n sequences, which the Worker turns back into newlines.
  GITHUB_APP_PRIVATE_KEY: app.privateKeyPkcs8Pem.replace(/\n/g, "\\n"),
};

// Keep any other local vars the developer has set.
const existing = existsSync(devVarsFile) ? await readFile(devVarsFile, "utf8") : "";
const kept = existing
  .split("\n")
  .filter((line) => line.trim() && !Object.keys(vars).some((key) => line.startsWith(`${key}=`)));
const lines = Object.entries(vars).map(([key, value]) => `${key}='${value}'`);
await writeFile(devVarsFile, `${[...kept, ...lines].join("\n")}\n`, { mode: 0o600 });

console.log(`e2e test identity ready: ${fileURLToPath(identityFile)}`);
console.log(`e2e GitHub App ready: ${fileURLToPath(GITHUB_APP_FILE)}`);
