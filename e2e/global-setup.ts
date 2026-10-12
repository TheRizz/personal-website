import { ASSERTION_HEADER, signAccessToken } from "./access";
import { BASE_URL } from "./helpers";

/**
 * Fails fast when the served build doesn't accept the e2e test identity, e.g. a build made before
 * `pnpm e2e:keys` or with keys from another checkout. Runs after the web server is up.
 */
export default async function globalSetup() {
  const response = await fetch(`${BASE_URL}/api/admin/me`, {
    headers: { [ASSERTION_HEADER]: await signAccessToken() },
  });
  if (response.status !== 200) {
    throw new Error(
      `The build on ${BASE_URL} refused the e2e test token (${response.status}). ` +
        "Run `pnpm e2e:keys && pnpm build` and try again (and stop any server still on that port).",
    );
  }
}
