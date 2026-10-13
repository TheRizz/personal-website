import { ASSERTION_HEADER, signAccessToken } from "./access";
import { STUB_URL, cleanUpDrafts, githubStub } from "./github";
import { BASE_URL } from "./helpers";

/**
 * Fails fast when the served build doesn't accept the e2e test identity, e.g. a build made before
 * `pnpm e2e:keys` or with keys from another checkout, or when it doesn't publish to the local
 * GitHub stub. Then clears what earlier runs left behind. Runs after both web servers are up.
 */
export default async function globalSetup() {
  const headers = { [ASSERTION_HEADER]: await signAccessToken() };
  const response = await fetch(`${BASE_URL}/api/admin/me`, { headers });
  if (response.status !== 200) {
    throw new Error(
      `The build on ${BASE_URL} refused the e2e test token (${response.status}). ` +
        "Run `pnpm e2e:keys && pnpm build` and try again (and stop any server still on that port).",
    );
  }

  // The posts list always asks GitHub for the content/blog tree, so the stub must have seen it.
  await githubStub.reset();
  const posts = await fetch(`${BASE_URL}/api/admin/posts`, { headers });
  await posts.body?.cancel();
  if (posts.status !== 200) {
    throw new Error(
      `The build can't reach the GitHub stub on ${STUB_URL} (${posts.status}): run ` +
        "`pnpm e2e:keys && pnpm build` (and check E2E_GITHUB_PORT).",
    );
  }
  const requests = await githubStub.requests();
  if (!requests.some((request) => request.operationName === "PostsTree")) {
    throw new Error("The build talks to a GitHub other than the stub; refusing to run.");
  }

  await cleanUpDrafts();
}
