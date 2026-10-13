/**
 * Prints an installation token for the publishing GitHub App, for the checks in hosting guide
 * §2.10 (Step 10.8). The App's private key stays where it was downloaded, outside the repo:
 *
 *   GH_TOKEN=$(pnpm app-token --key ~/keys/<app>.pem --client-id <Client ID>) gh api …
 *
 * `--client-id` can also come from GITHUB_APP_CLIENT_ID. The installation is looked up on this
 * repository. Only the token is printed, so it can be captured; it expires within an hour.
 */
import { createPrivateKey, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const REPO = "TheRizz/personal-website";
const API = "https://api.github.com";

const { values } = parseArgs({
  options: {
    key: { type: "string" },
    "client-id": { type: "string" },
    repo: { type: "string", default: REPO },
  },
});
const clientId = values["client-id"] ?? process.env.GITHUB_APP_CLIENT_ID;
if (!values.key || !clientId) {
  console.error("Usage: pnpm app-token --key <path to the App's .pem> --client-id <Client ID>");
  process.exit(2);
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/** The App's own JWT (RS256): issued a minute early for clock drift, valid for 9 minutes. */
function appJwt(pem: string, issuer: string): string {
  // GitHub hands out PKCS#1 keys; node reads both that and PKCS#8.
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: issuer }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${base64url(signature)}`;
}

async function github<T>(path: string, token: string, method = "GET"): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ry-mart-app-token",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

try {
  const jwt = appJwt(await readFile(values.key, "utf8"), clientId);
  const { id } = await github<{ id: number }>(`/repos/${values.repo}/installation`, jwt);
  const { token } = await github<{ token: string }>(
    `/app/installations/${id}/access_tokens`,
    jwt,
    "POST",
  );
  console.log(token);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
